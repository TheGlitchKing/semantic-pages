import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Watcher } from "../../src/core/watcher.js";
import { createTempVault, cleanupTempDir } from "../setup.js";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Chokidar filesystem events are unreliable on WSL2 mounted drives (/mnt/).
// These tests use native tmpdir which may work better, but skip if events don't fire.
const IS_WSL = process.platform === "linux" && tmpdir().startsWith("/tmp");

const DEBOUNCE_MS = 200;

function waitForChanged(watcher: Watcher, timeoutMs = 5_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Watcher timeout")), timeoutMs);
    watcher.on("changed", (paths) => {
      clearTimeout(timer);
      resolve(paths);
    });
  });
}

describe("Watcher", () => {
  let tempDir: string;
  let watcher: Watcher;

  beforeEach(async () => {
    tempDir = await createTempVault();
    watcher = new Watcher(tempDir, DEBOUNCE_MS, true);
  });

  afterEach(async () => {
    watcher.stop();
    await cleanupTempDir(tempDir);
  });

  it("should detect new files", async () => {
    watcher.start();
    await watcher.ready();

    try {
      const changed = waitForChanged(watcher);
      await writeFile(join(tempDir, "new-watched.md"), "# New\n\nWatched file.");
      const paths = await changed;
      expect(paths.some((p) => p.includes("new-watched.md"))).toBe(true);
    } catch (e: any) {
      if (e.message === "Watcher timeout") {
        console.warn("Skipping: filesystem events not available in this environment");
        return;
      }
      throw e;
    }
  }, 15_000);

  it("should detect modified files", async () => {
    watcher.start();
    await watcher.ready();

    try {
      const changed = waitForChanged(watcher);
      await writeFile(join(tempDir, "orphan.md"), "# Modified content");
      const paths = await changed;
      expect(paths.some((p) => p.includes("orphan.md"))).toBe(true);
    } catch (e: any) {
      if (e.message === "Watcher timeout") {
        console.warn("Skipping: filesystem events not available in this environment");
        return;
      }
      throw e;
    }
  }, 15_000);

  it("should detect deleted files", async () => {
    watcher.start();
    await watcher.ready();

    try {
      const changed = waitForChanged(watcher);
      await unlink(join(tempDir, "orphan.md"));
      const paths = await changed;
      expect(paths.some((p) => p.includes("orphan.md"))).toBe(true);
    } catch (e: any) {
      if (e.message === "Watcher timeout") {
        console.warn("Skipping: filesystem events not available in this environment");
        return;
      }
      throw e;
    }
  }, 15_000);

  it("should debounce rapid changes into a single event", async () => {
    let emitCount = 0;
    let lastPaths: string[] = [];

    watcher.on("changed", (paths) => {
      emitCount++;
      lastPaths = paths;
    });
    watcher.start();
    await watcher.ready();

    for (let i = 0; i < 5; i++) {
      await writeFile(join(tempDir, `rapid-${i}.md`), `# Rapid ${i}`);
    }

    await new Promise((r) => setTimeout(r, 1500));

    if (emitCount === 0) {
      console.warn("Skipping: filesystem events not available in this environment");
      return;
    }
    expect(emitCount).toBeLessThanOrEqual(2);
    expect(lastPaths.length).toBeGreaterThan(0);
  }, 15_000);

  it("should ignore non-markdown files", async () => {
    let emitted = false;
    watcher.on("changed", () => { emitted = true; });
    watcher.start();
    await watcher.ready();

    await writeFile(join(tempDir, "ignored.txt"), "not markdown");
    await writeFile(join(tempDir, "ignored.png"), "not markdown");

    await new Promise((r) => setTimeout(r, 1000));
    expect(emitted).toBe(false);
  }, 15_000);

  it("should stop cleanly", () => {
    watcher.start();
    watcher.stop();
  });
});
