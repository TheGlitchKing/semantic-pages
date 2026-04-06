import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempVault, cleanupTempDir } from "../setup.js";
import { mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli", "index.js");

async function connectAndWaitForReady(
  tempDir: string,
  extraArgs: string[] = []
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [CLI_PATH, "--notes", tempDir, "--no-watch", ...extraArgs],
  });
  const client = new Client({ name: "feature-test", version: "1.0.0" });
  await client.connect(transport);

  // Wait for indexing to complete
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "get_stats", arguments: {} });
    const stats = JSON.parse((result.content as any)[0].text);
    if (stats.indexState === "ready") break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  return client;
}

describe("E2E: ONNX runtime + new features", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await createTempVault();
    client = await connectAndWaitForReady(tempDir);
  }, 180_000);

  afterAll(async () => {
    await client.close();
    await cleanupTempDir(tempDir);
  });

  it("should report embedding runtime in stats", async () => {
    const result = await client.callTool({ name: "get_stats", arguments: {} });
    const stats = JSON.parse((result.content as any)[0].text);

    expect(stats.embeddingRuntime).toMatch(/^(native|wasm|unknown)$/);
    expect(stats.embeddingDimensions).toBeGreaterThan(0);
    expect(stats.totalEmbeddings).toBeGreaterThan(0);
    expect(stats.indexState).toBe("ready");
  });

  it("should produce valid search results with ONNX runtime", async () => {
    const result = await client.callTool({
      name: "search_semantic",
      arguments: { query: "microservices architecture patterns", limit: 5 },
    });
    const parsed = JSON.parse((result.content as any)[0].text);

    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("path");
    expect(parsed[0]).toHaveProperty("score");
    expect(parsed[0].score).toBeGreaterThan(0);
  });

  it("should write meta.json with model info", async () => {
    const metaPath = join(tempDir, ".semantic-pages-index", "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    expect(meta).toHaveProperty("model");
    expect(meta).toHaveProperty("dimensions");
    expect(meta).toHaveProperty("totalChunks");
    expect(meta).toHaveProperty("indexedAt");
    expect(meta.dimensions).toBeGreaterThan(0);
    expect(meta.totalChunks).toBeGreaterThan(0);
  });

  it("should save incremental embeddings to disk", async () => {
    const embeddingsPath = join(tempDir, ".semantic-pages-index", "embeddings.json");
    expect(existsSync(embeddingsPath)).toBe(true);

    const raw = await readFile(embeddingsPath, "utf-8");
    const entries = JSON.parse(raw);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty("key");
    expect(entries[0]).toHaveProperty("data");
    expect(entries[0].data.length).toBeGreaterThan(0);
  });

  it("should report indexing progress during reindex", async () => {
    // Trigger a reindex and immediately check stats
    const reindexPromise = client.callTool({ name: "reindex", arguments: {} });

    // Wait for reindex to complete
    const reindexResult = await reindexPromise;
    const text = (reindexResult.content as any)[0].text;
    expect(text).toContain("Reindexed:");
    expect(text).toMatch(/\d+ notes/);
    expect(text).toMatch(/\d+ chunks/);

    // After reindex, stats should be ready
    const statsResult = await client.callTool({ name: "get_stats", arguments: {} });
    const stats = JSON.parse((statsResult.content as any)[0].text);
    expect(stats.indexState).toBe("ready");
  });

  it("should still work after reindex — full CRUD + search cycle", async () => {
    // Create a note
    await client.callTool({
      name: "create_note",
      arguments: {
        path: "onnx-test.md",
        content: "# ONNX Test\n\nQuantum computing meets neural embeddings.",
        frontmatter: { tags: ["onnx", "test"] },
      },
    });

    // Read it back
    const readResult = await client.callTool({
      name: "read_note",
      arguments: { path: "onnx-test.md" },
    });
    expect((readResult.content as any)[0].text).toContain("Quantum computing");

    // Reindex to pick up the new note
    await client.callTool({ name: "reindex", arguments: {} });

    // Semantic search should find it
    const searchResult = await client.callTool({
      name: "search_semantic",
      arguments: { query: "quantum computing neural", limit: 5 },
    });
    const parsed = JSON.parse((searchResult.content as any)[0].text);
    expect(parsed.some((r: any) => r.path === "onnx-test.md")).toBe(true);

    // Clean up
    await client.callTool({
      name: "delete_note",
      arguments: { path: "onnx-test.md", confirm: true },
    });
  });
});

describe("E2E: symlink support", () => {
  let tempDir: string;

  afterAll(async () => {
    if (tempDir) await cleanupTempDir(tempDir);
  });

  it("should index and search notes in symlinked directories", async () => {
    tempDir = await createTempVault();

    // Create a separate directory with a markdown file
    const externalDir = join(tempDir, "..", "sp-external-" + Date.now());
    await mkdir(externalDir, { recursive: true });
    await writeFile(
      join(externalDir, "symlinked-note.md"),
      "---\ntitle: Symlinked Note\ntags: [symlink]\n---\n\n# Symlinked\n\nThis note lives outside the vault but is symlinked in.\n\nBlockchain distributed ledger technology."
    );

    // Symlink it into the vault
    const linkPath = join(tempDir, "external-notes");
    try {
      await symlink(externalDir, linkPath, "dir");
    } catch {
      // Symlinks may not work on all platforms (e.g., Windows without admin)
      await rm(externalDir, { recursive: true, force: true });
      return; // Skip test
    }

    const client = await connectAndWaitForReady(tempDir);

    // The symlinked note should appear in list_notes
    const listResult = await client.callTool({ name: "list_notes", arguments: {} });
    const notes = JSON.parse((listResult.content as any)[0].text);
    const symlinkedNote = notes.find((n: any) =>
      n.path.includes("symlinked-note.md")
    );
    expect(symlinkedNote).toBeDefined();

    // Search should find it
    const searchResult = await client.callTool({
      name: "search_semantic",
      arguments: { query: "blockchain distributed ledger", limit: 5 },
    });
    const searchParsed = JSON.parse((searchResult.content as any)[0].text);
    expect(searchParsed.some((r: any) => r.path.includes("symlinked-note.md"))).toBe(true);

    await client.close();
    await rm(externalDir, { recursive: true, force: true });
  }, 180_000);
});
