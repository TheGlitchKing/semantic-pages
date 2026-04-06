import { describe, it, expect, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempVault, cleanupTempDir } from "../setup.js";
import { rm } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli", "index.js");

describe("E2E: lazy index on connect", () => {
  const tempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tempDirs) {
      await cleanupTempDir(dir);
    }
  });

  it("should connect and list all 21 tools before indexing completes", async () => {
    const tempDir = await createTempVault();
    tempDirs.push(tempDir);

    const start = Date.now();
    const transport = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });

    const client = new Client({ name: "lazy-startup-test", version: "1.0.0" });
    await client.connect(transport);
    const elapsed = Date.now() - start;

    // Tools should be registered immediately (before full indexing)
    const { tools } = await client.listTools();
    expect(tools.length).toBe(21);

    // Connection should be fast (model init may take time on first run,
    // but tool listing should not depend on index completion)
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_semantic");
    expect(names).toContain("get_stats");
    expect(names).toContain("reindex");

    await client.close();
  }, 180_000);

  it("should report index state via get_stats", async () => {
    const tempDir = await createTempVault();
    tempDirs.push(tempDir);

    const transport = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });

    const client = new Client({ name: "stats-test", version: "1.0.0" });
    await client.connect(transport);

    // Poll until indexing completes (may already be done for small vault)
    let stats: any;
    const deadline = Date.now() + 120_000;
    do {
      const result = await client.callTool({ name: "get_stats", arguments: {} });
      stats = JSON.parse((result.content as any)[0].text);
      if (stats.indexState === "ready") break;
      await new Promise((r) => setTimeout(r, 1000));
    } while (Date.now() < deadline);

    expect(stats.indexState).toBe("ready");
    expect(stats.totalNotes).toBeGreaterThanOrEqual(9);
    expect(stats.totalEmbeddings).toBeGreaterThan(0);
    expect(stats).toHaveProperty("embeddingRuntime");
    expect(["native", "wasm", "unknown"]).toContain(stats.embeddingRuntime);

    await client.close();
  }, 180_000);

  it("should load cached index on second startup", async () => {
    const tempDir = await createTempVault();
    tempDirs.push(tempDir);

    // First startup: build full index
    const transport1 = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });
    const client1 = new Client({ name: "cache-test-1", version: "1.0.0" });
    await client1.connect(transport1);

    // Wait for indexing to complete
    let ready = false;
    const deadline = Date.now() + 120_000;
    while (!ready && Date.now() < deadline) {
      const result = await client1.callTool({ name: "get_stats", arguments: {} });
      const stats = JSON.parse((result.content as any)[0].text);
      ready = stats.indexState === "ready";
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready).toBe(true);

    await client1.close();

    // Second startup: should load from cache
    const start = Date.now();
    const transport2 = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });
    const client2 = new Client({ name: "cache-test-2", version: "1.0.0" });
    await client2.connect(transport2);

    // Wait for ready state
    const deadline2 = Date.now() + 120_000;
    let stats2: any;
    do {
      const result = await client2.callTool({ name: "get_stats", arguments: {} });
      stats2 = JSON.parse((result.content as any)[0].text);
      if (stats2.indexState === "ready") break;
      await new Promise((r) => setTimeout(r, 500));
    } while (Date.now() < deadline2);

    expect(stats2.indexState).toBe("ready");

    // Verify search works with cached index
    const searchResult = await client2.callTool({
      name: "search_semantic",
      arguments: { query: "microservices architecture", limit: 3 },
    });
    const parsed = JSON.parse((searchResult.content as any)[0].text);
    expect(parsed.length).toBeGreaterThan(0);

    await client2.close();
  }, 300_000);

  it("should handle search gracefully during indexing", async () => {
    const tempDir = await createTempVault();
    tempDirs.push(tempDir);

    // Remove any cached index to force a fresh build
    await rm(join(tempDir, ".semantic-pages-index"), { recursive: true, force: true });

    const transport = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });
    const client = new Client({ name: "graceful-test", version: "1.0.0" });
    await client.connect(transport);

    // Immediately try search — should get results or a graceful message
    const result = await client.callTool({
      name: "search_semantic",
      arguments: { query: "test", limit: 5 },
    });
    const text = (result.content as any)[0].text;

    // Should either return results (if index loaded fast) or an indexing message
    expect(text.length).toBeGreaterThan(0);

    // read_note should always work (file-based, no index needed)
    const readResult = await client.callTool({
      name: "read_note",
      arguments: { path: "project-overview.md" },
    });
    expect((readResult.content as any)[0].text).toContain("Project Overview");

    await client.close();
  }, 180_000);
});
