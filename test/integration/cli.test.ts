import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { FIXTURES_VAULT } from "../setup.js";

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "..", "dist", "cli", "index.js");

describe("CLI", () => {
  it("should show stats for a vault", async () => {
    const { stdout } = await exec("node", [CLI, "--notes", FIXTURES_VAULT, "--stats"]);
    expect(stdout).toContain("Notes:");
    expect(stdout).toContain("Chunks:");
    expect(stdout).toContain("Wikilinks:");
    expect(stdout).toContain("Tags:");
  });

  it("should error on nonexistent path", async () => {
    try {
      await exec("node", [CLI, "--notes", "/tmp/nonexistent-vault-12345", "--stats"]);
      expect.unreachable("Should have exited with error");
    } catch (err: any) {
      expect(err.stderr || err.message).toContain("not found");
    }
  });

  it("should error when --notes is missing", async () => {
    try {
      await exec("node", [CLI, "--stats"]);
      expect.unreachable("Should have exited with error");
    } catch (err: any) {
      expect(err.stderr || err.message).toContain("required");
    }
  });

  it("should show version", async () => {
    const { stdout } = await exec("node", [CLI, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("should show help", async () => {
    const { stdout } = await exec("node", [CLI, "--help"]);
    expect(stdout).toContain("tools");
    expect(stdout).toContain("serve");
  });

  it("should list all tools", async () => {
    const { stdout } = await exec("node", [CLI, "tools"]);
    expect(stdout).toContain("21 MCP Tools");
    expect(stdout).toContain("search_semantic");
    expect(stdout).toContain("create_note");
    expect(stdout).toContain("backlinks");
    expect(stdout).toContain("reindex");
  });

  it("should show detail for a specific tool", async () => {
    const { stdout } = await exec("node", [CLI, "tools", "update_note"]);
    expect(stdout).toContain("update_note");
    expect(stdout).toContain("Arguments:");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("patch-by-heading");
  });

  it("should error on unknown tool name", async () => {
    try {
      await exec("node", [CLI, "tools", "fake_tool"]);
      expect.unreachable("Should have exited with error");
    } catch (err: any) {
      expect(err.stderr || err.message).toContain("Unknown tool");
    }
  });
});
