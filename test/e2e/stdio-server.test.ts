import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createTempVault, cleanupTempDir } from "../setup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, "..", "..", "dist", "cli", "index.js");

describe("E2E: stdio MCP server", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await createTempVault();

    transport = new StdioClientTransport({
      command: "node",
      args: [CLI_PATH, "--notes", tempDir, "--no-watch"],
    });

    client = new Client({ name: "e2e-test-client", version: "1.0.0" });
    await client.connect(transport);
  }, 180_000); // model download + full index build

  afterAll(async () => {
    await client.close();
    await cleanupTempDir(tempDir);
  });

  it("should connect and list tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(21);
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_semantic");
    expect(names).toContain("create_note");
    expect(names).toContain("reindex");
  });

  it("should search semantically", async () => {
    const result = await client.callTool({
      name: "search_semantic",
      arguments: { query: "event driven architecture messaging", limit: 3 },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("path");
    expect(parsed[0]).toHaveProperty("score");
  });

  it("should search by text", async () => {
    const result = await client.callTool({
      name: "search_text",
      arguments: { pattern: "RabbitMQ" },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.length).toBe(1);
    expect(parsed[0].path).toBe("event-driven.md");
  });

  it("should read a note", async () => {
    const result = await client.callTool({
      name: "read_note",
      arguments: { path: "project-overview.md" },
    });
    const text = (result.content as any)[0].text;
    expect(text).toContain("Project Overview");
    expect(text).toContain("[[microservices]]");
  });

  it("should list all notes", async () => {
    const result = await client.callTool({
      name: "list_notes",
      arguments: {},
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.length).toBeGreaterThanOrEqual(9);
  });

  it("should create, read, update, search, and delete a note", async () => {
    // Create
    await client.callTool({
      name: "create_note",
      arguments: {
        path: "e2e-test.md",
        content: "# E2E Test\n\nQuantum entanglement in distributed systems.",
        frontmatter: { tags: ["e2e", "quantum"] },
      },
    });

    // Read
    const readResult = await client.callTool({
      name: "read_note",
      arguments: { path: "e2e-test.md" },
    });
    expect((readResult.content as any)[0].text).toContain("Quantum entanglement");

    // Update (append)
    await client.callTool({
      name: "update_note",
      arguments: {
        path: "e2e-test.md",
        content: "\n\n## Addendum\n\nThis was appended via MCP.",
        mode: "append",
      },
    });
    const readAfterUpdate = await client.callTool({
      name: "read_note",
      arguments: { path: "e2e-test.md" },
    });
    expect((readAfterUpdate.content as any)[0].text).toContain("Addendum");

    // Frontmatter
    await client.callTool({
      name: "update_frontmatter",
      arguments: { path: "e2e-test.md", fields: { status: "tested" } },
    });
    const fmResult = await client.callTool({
      name: "get_frontmatter",
      arguments: { path: "e2e-test.md" },
    });
    expect(JSON.parse((fmResult.content as any)[0].text).status).toBe("tested");

    // Tags
    await client.callTool({
      name: "manage_tags",
      arguments: { path: "e2e-test.md", action: "add", tags: ["verified"] },
    });
    const tagResult = await client.callTool({
      name: "manage_tags",
      arguments: { path: "e2e-test.md", action: "list" },
    });
    expect(JSON.parse((tagResult.content as any)[0].text)).toContain("verified");

    // Reindex to pick up the new note
    await client.callTool({ name: "reindex", arguments: {} });

    // Semantic search should find it
    const searchResult = await client.callTool({
      name: "search_semantic",
      arguments: { query: "quantum entanglement distributed", limit: 5 },
    });
    const searchParsed = JSON.parse((searchResult.content as any)[0].text);
    expect(searchParsed.some((r: any) => r.path === "e2e-test.md")).toBe(true);

    // Text search should find it
    const textResult = await client.callTool({
      name: "search_text",
      arguments: { pattern: "entanglement" },
    });
    const textParsed = JSON.parse((textResult.content as any)[0].text);
    expect(textParsed.some((r: any) => r.path === "e2e-test.md")).toBe(true);

    // Delete
    await client.callTool({
      name: "delete_note",
      arguments: { path: "e2e-test.md", confirm: true },
    });

    // Verify deleted
    try {
      await client.callTool({
        name: "read_note",
        arguments: { path: "e2e-test.md" },
      });
      expect.unreachable("Should have thrown");
    } catch {
      // Expected
    }
  });

  it("should traverse the knowledge graph", async () => {
    // Backlinks
    const blResult = await client.callTool({
      name: "backlinks",
      arguments: { path: "microservices.md" },
    });
    const backlinks = JSON.parse((blResult.content as any)[0].text);
    expect(backlinks.map((n: any) => n.path)).toContain("project-overview.md");

    // Forwardlinks
    const flResult = await client.callTool({
      name: "forwardlinks",
      arguments: { path: "project-overview.md" },
    });
    const fwd = JSON.parse((flResult.content as any)[0].text);
    expect(fwd.map((n: any) => n.path)).toContain("microservices.md");

    // Path finding
    const pathResult = await client.callTool({
      name: "graph_path",
      arguments: { from: "project-overview.md", to: "user-service.md" },
    });
    const graphPath = JSON.parse((pathResult.content as any)[0].text);
    expect(graphPath[0]).toBe("project-overview.md");
    expect(graphPath[graphPath.length - 1]).toBe("user-service.md");

    // Statistics
    const statsResult = await client.callTool({
      name: "graph_statistics",
      arguments: {},
    });
    const stats = JSON.parse((statsResult.content as any)[0].text);
    expect(stats.totalNodes).toBeGreaterThanOrEqual(9);
    expect(stats.totalEdges).toBeGreaterThan(0);
  });

  it("should return vault stats", async () => {
    const result = await client.callTool({
      name: "get_stats",
      arguments: {},
    });
    const stats = JSON.parse((result.content as any)[0].text);
    expect(stats.totalNotes).toBeGreaterThanOrEqual(9);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalEmbeddings).toBeGreaterThan(0);
    expect(stats.embeddingDimensions).toBeGreaterThan(0);
    expect(stats.embeddingModel).toContain("nomic");
  });

  it("should move a note and update wikilinks", async () => {
    // Create a note that links to user-service
    await client.callTool({
      name: "create_note",
      arguments: {
        path: "move-test.md",
        content: "See [[user-service]] for auth.",
      },
    });

    // Move user-service → auth-service
    await client.callTool({
      name: "move_note",
      arguments: { from: "user-service.md", to: "auth-service.md" },
    });

    // Check that move-test.md wikilink was updated
    const readResult = await client.callTool({
      name: "read_note",
      arguments: { path: "move-test.md" },
    });
    const text = (readResult.content as any)[0].text;
    expect(text).toContain("[[auth-service]]");
    expect(text).not.toContain("[[user-service]]");

    // Check microservices.md wikilink was also updated
    const microResult = await client.callTool({
      name: "read_note",
      arguments: { path: "microservices.md" },
    });
    expect((microResult.content as any)[0].text).toContain("[[auth-service]]");

    // Cleanup
    await client.callTool({
      name: "delete_note",
      arguments: { path: "move-test.md", confirm: true },
    });
  });

  it("should rename a tag vault-wide", async () => {
    const result = await client.callTool({
      name: "rename_tag",
      arguments: { oldTag: "architecture", newTag: "arch" },
    });
    const text = (result.content as any)[0].text;
    expect(text).toContain("arch");

    // Verify the change took effect
    const fmResult = await client.callTool({
      name: "get_frontmatter",
      arguments: { path: "microservices.md" },
    });
    const fm = JSON.parse((fmResult.content as any)[0].text);
    expect(fm.tags).toContain("arch");
    expect(fm.tags).not.toContain("architecture");
  });

  it("should handle hybrid search", async () => {
    const result = await client.callTool({
      name: "search_hybrid",
      arguments: { query: "service deployment containers", limit: 5 },
    });
    const parsed = JSON.parse((result.content as any)[0].text);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toHaveProperty("score");
  });
});
