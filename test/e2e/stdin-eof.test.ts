/**
 * Process lifecycle test — stdin EOF reaping
 *
 * Regression test for the orphan-process / RAM-exhaustion bug:
 *   When the parent (Claude Code) dies, stdin EOF must cause the server to exit.
 *   Without the fix, the chokidar FSWatcher and ONNX native thread-pool keep the
 *   event loop alive indefinitely, producing one zombie ~180–200 MB process per
 *   Claude session until the host runs out of RAM and freezes.
 *
 * The test spawns the server directly (same as MCP does), waits for it to be
 * fully initialized (ONNX session live, file watcher running — the two handles
 * that keep the event loop alive without the fix), then closes stdin and asserts
 * the process exits within 3 seconds.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempVault, cleanupTempDir } from "../setup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli", "index.js");

describe("E2E: process lifecycle — stdin EOF reaping", () => {
  it(
    "exits when stdin closes (simulates parent-process death)",
    async () => {
      const tempDir = await createTempVault();
      try {
        // Spawn exactly as MCP does: the parent owns the pipe, the child reads
        // from its stdin. --wait-for-ready ensures the ONNX InferenceSession is
        // initialized before we close stdin (otherwise the test might pass trivially
        // because the event loop has nothing alive yet). File watcher is left on
        // (default) so chokidar's inotify fd is also active.
        const child = spawn("node", [CLI_PATH, "--notes", tempDir, "--wait-for-ready"], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Collect stderr so test failures print something useful
        const stderrLines: string[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderrLines.push(chunk.toString()));

        // Wait until the embedder announces it is ready — at that point the ONNX
        // session is live and the file watcher is running.
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Server did not become ready.\nstderr:\n${stderrLines.join("")}`)),
            120_000,
          );
          child.stderr.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("Embedder ready")) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.on("error", (err) => { clearTimeout(timeout); reject(err); });
          child.on("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Server exited early (code ${code}) before becoming ready.\nstderr:\n${stderrLines.join("")}`));
          });
        });

        // Simulate parent death: close the write end of stdin (sends EOF to child).
        child.stdin.end();

        // The server must exit on its own within 3 seconds. Before the fix it
        // would run forever; if it doesn't exit we SIGKILL it and fail.
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(
              "Server did not exit within 3 s after stdin close — " +
              "process-leak bug still present.\n" +
              `stderr:\n${stderrLines.join("")}`,
            ));
          }, 3_000);
          child.on("exit", (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });

        // process.exit(0) → code 0
        expect(exitCode).toBe(0);
      } finally {
        await cleanupTempDir(tempDir);
      }
    },
    180_000, // model download + full index build on first run
  );

  it(
    "exits on SIGTERM (process manager shutdown)",
    async () => {
      const tempDir = await createTempVault();
      try {
        // Use lazy startup (no --wait-for-ready) so createServer() returns
        // immediately and the SIGTERM handler is registered in startServer()
        // before background indexing prints "Embedder ready". That ordering
        // guarantee is what we need: by the time we see any stderr output the
        // handler is already wired up.
        const child = spawn("node", [CLI_PATH, "--notes", tempDir, "--no-watch"], {
          stdio: ["pipe", "pipe", "pipe"],
        });

        const stderrLines: string[] = [];
        child.stderr.on("data", (chunk: Buffer) => stderrLines.push(chunk.toString()));

        // Wait for "Embedder ready" — with lazy startup this fires from the
        // background goroutine AFTER startServer() has registered SIGTERM handler.
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Server did not become ready.\nstderr:\n${stderrLines.join("")}`)),
            120_000,
          );
          child.stderr.on("data", (chunk: Buffer) => {
            if (chunk.toString().includes("Embedder ready")) {
              clearTimeout(timeout);
              resolve();
            }
          });
          child.on("error", (err) => { clearTimeout(timeout); reject(err); });
          child.on("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`Server exited early (code ${code}).\nstderr:\n${stderrLines.join("")}`));
          });
        });

        child.kill("SIGTERM");

        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Server did not exit within 3 s after SIGTERM"));
          }, 3_000);
          child.on("exit", (code) => {
            clearTimeout(timeout);
            resolve(code);
          });
        });

        expect(exitCode).toBe(0);
      } finally {
        await cleanupTempDir(tempDir);
      }
    },
    180_000,
  );
});
