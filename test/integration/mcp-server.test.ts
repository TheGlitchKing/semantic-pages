import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/server.js";
import { createTempVault, cleanupTempDir } from "../setup.js";

describe("MCP Server", () => {
  let client: Client;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await createTempVault();
    // waitForReady forces blocking startup: model load + tryLoadCachedIndex +
    // fullIndex all complete before createServer() returns. Without this the
    // index builds in the background and tool calls race against indexState,
    // causing search/list tools to return "Indexing in progress..." strings
    // (not JSON) and get_stats to report totalNotes: 0. See src/mcp/server.ts
    // line 645 for the waitForReady branch.
    const server = await createServer(tempDir, { watch: false, waitForReady: true });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  }, 180_000); // model download + indexing

  afterAll(async () => {
    await client.close();
    await cleanupTempDir(tempDir);
  });

  it("should list all 22 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(21);
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_semantic");
    expect(names).toContain("search_text");
    expect(names).toContain("search_graph");
    expect(names).toContain("search_hybrid");
    expect(names).toContain("read_note");
    expect(names).toContain("read_multiple_notes");
    expect(names).toContain("list_notes");
    expect(names).toContain("create_note");
    expect(names).toContain("update_note");
    expect(names).toContain("delete_note");
    expect(names).toContain("move_note");
    expect(names).toContain("get_frontmatter");
    expect(names).toContain("update_frontmatter");
    expect(names).toContain("manage_tags");
    expect(names).toContain("rename_tag");
    expect(names).toContain("backlinks");
    expect(names).toContain("forwardlinks");
    expect(names).toContain("graph_path");
    expect(names).toContain("graph_statistics");
    expect(names).toContain("get_stats");
    expect(names).toContain("reindex");
  });

  describe("Search tools", () => {
    it("search_semantic should return results", async () => {
      const result = await client.callTool({
        name: "search_semantic",
        arguments: { query: "microservices architecture", limit: 5 },
      });
      const text = (result.content as any)[0].text;
      const parsed = JSON.parse(text);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]).toHaveProperty("path");
      expect(parsed[0]).toHaveProperty("score");
    });

    it("search_text should find keyword matches", async () => {
      const result = await client.callTool({
        name: "search_text",
        arguments: { pattern: "RabbitMQ" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].path).toBe("event-driven.md");
    });

    it("search_graph should find connected notes", async () => {
      const result = await client.callTool({
        name: "search_graph",
        arguments: { concept: "microservices" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.length).toBeGreaterThan(0);
      const paths = parsed.map((r: any) => r.path);
      expect(paths).toContain("microservices.md");
    });

    it("search_hybrid should combine semantic and graph", async () => {
      const result = await client.callTool({
        name: "search_hybrid",
        arguments: { query: "event driven architecture", limit: 5 },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.length).toBeGreaterThan(0);
    });
  });

  describe("Read tools", () => {
    it("read_note should return note content", async () => {
      const result = await client.callTool({
        name: "read_note",
        arguments: { path: "project-overview.md" },
      });
      const text = (result.content as any)[0].text;
      expect(text).toContain("Project Overview");
      expect(text).toContain("[[microservices]]");
    });

    it("read_multiple_notes should batch read", async () => {
      const result = await client.callTool({
        name: "read_multiple_notes",
        arguments: { paths: ["project-overview.md", "orphan.md"] },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed["project-overview.md"]).toContain("Project Overview");
      expect(parsed["orphan.md"]).toContain("Orphan");
    });

    it("list_notes should return all notes with metadata", async () => {
      const result = await client.callTool({
        name: "list_notes",
        arguments: {},
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.length).toBeGreaterThanOrEqual(9);
      expect(parsed[0]).toHaveProperty("path");
      expect(parsed[0]).toHaveProperty("title");
      expect(parsed[0]).toHaveProperty("tags");
    });
  });

  describe("Write tools", () => {
    it("create_note should create a new file", async () => {
      const result = await client.callTool({
        name: "create_note",
        arguments: {
          path: "test-created.md",
          content: "# Test\n\nCreated via MCP.",
          frontmatter: { tags: ["test"] },
        },
      });
      const text = (result.content as any)[0].text;
      expect(text).toContain("Created");

      // Verify it's readable
      const read = await client.callTool({
        name: "read_note",
        arguments: { path: "test-created.md" },
      });
      expect((read.content as any)[0].text).toContain("Created via MCP");
    });

    it("update_note should modify content", async () => {
      await client.callTool({
        name: "update_note",
        arguments: {
          path: "test-created.md",
          content: "\n\nAppended line.",
          mode: "append",
        },
      });
      const read = await client.callTool({
        name: "read_note",
        arguments: { path: "test-created.md" },
      });
      expect((read.content as any)[0].text).toContain("Appended line");
    });

    it("delete_note should require confirmation", async () => {
      const result = await client.callTool({
        name: "delete_note",
        arguments: { path: "test-created.md", confirm: false },
      });
      expect((result.content as any)[0].text).toContain("confirm=true");
    });

    it("delete_note should delete with confirmation", async () => {
      await client.callTool({
        name: "delete_note",
        arguments: { path: "test-created.md", confirm: true },
      });
      // Reading deleted note should fail
      try {
        await client.callTool({
          name: "read_note",
          arguments: { path: "test-created.md" },
        });
        expect.unreachable("Should have thrown");
      } catch {
        // Expected
      }
    });

    it("move_note should rename and update wikilinks", async () => {
      await client.callTool({
        name: "create_note",
        arguments: { path: "move-source.md", content: "Source note." },
      });
      const result = await client.callTool({
        name: "move_note",
        arguments: { from: "move-source.md", to: "move-dest.md" },
      });
      expect((result.content as any)[0].text).toContain("→");

      const read = await client.callTool({
        name: "read_note",
        arguments: { path: "move-dest.md" },
      });
      expect((read.content as any)[0].text).toContain("Source note");

      // Cleanup
      await client.callTool({
        name: "delete_note",
        arguments: { path: "move-dest.md", confirm: true },
      });
    });
  });

  describe("Metadata tools", () => {
    it("get_frontmatter should return parsed YAML", async () => {
      const result = await client.callTool({
        name: "get_frontmatter",
        arguments: { path: "project-overview.md" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.title).toBe("Project Overview");
    });

    it("update_frontmatter should set fields", async () => {
      await client.callTool({
        name: "update_frontmatter",
        arguments: { path: "orphan.md", fields: { status: "reviewed" } },
      });
      const result = await client.callTool({
        name: "get_frontmatter",
        arguments: { path: "orphan.md" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.status).toBe("reviewed");
    });

    it("manage_tags list should return tags", async () => {
      const result = await client.callTool({
        name: "manage_tags",
        arguments: { path: "project-overview.md", action: "list" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed).toContain("project");
    });

    it("manage_tags add should add tags", async () => {
      await client.callTool({
        name: "manage_tags",
        arguments: { path: "orphan.md", action: "add", tags: ["mcp-test"] },
      });
      const result = await client.callTool({
        name: "manage_tags",
        arguments: { path: "orphan.md", action: "list" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed).toContain("mcp-test");
    });

    it("rename_tag should rename across vault", async () => {
      const result = await client.callTool({
        name: "rename_tag",
        arguments: { oldTag: "mcp-test", newTag: "mcp-renamed" },
      });
      expect((result.content as any)[0].text).toContain("mcp-renamed");
    });
  });

  describe("Graph tools", () => {
    it("backlinks should find incoming links", async () => {
      const result = await client.callTool({
        name: "backlinks",
        arguments: { path: "microservices.md" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const paths = parsed.map((n: any) => n.path);
      expect(paths).toContain("project-overview.md");
    });

    it("forwardlinks should find outgoing links", async () => {
      const result = await client.callTool({
        name: "forwardlinks",
        arguments: { path: "project-overview.md" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const paths = parsed.map((n: any) => n.path);
      expect(paths).toContain("microservices.md");
    });

    it("graph_path should find route between notes", async () => {
      const result = await client.callTool({
        name: "graph_path",
        arguments: { from: "project-overview.md", to: "user-service.md" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed[0]).toBe("project-overview.md");
      expect(parsed[parsed.length - 1]).toBe("user-service.md");
    });

    it("graph_statistics should return stats", async () => {
      const result = await client.callTool({
        name: "graph_statistics",
        arguments: {},
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.totalNodes).toBeGreaterThan(0);
      expect(parsed.totalEdges).toBeGreaterThan(0);
      expect(parsed).toHaveProperty("density");
    });
  });

  describe("System tools", () => {
    it("get_stats should return vault statistics", async () => {
      const result = await client.callTool({
        name: "get_stats",
        arguments: {},
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.totalNotes).toBeGreaterThanOrEqual(9);
      expect(parsed.totalChunks).toBeGreaterThan(0);
      expect(parsed.totalEmbeddings).toBeGreaterThan(0);
      expect(parsed.embeddingDimensions).toBeGreaterThan(0);
      expect(parsed).toHaveProperty("embeddingModel");
      expect(parsed).toHaveProperty("lastIndexed");
    });

    it("reindex should rebuild and report counts", async () => {
      const result = await client.callTool({
        name: "reindex",
        arguments: {},
      });
      const text = (result.content as any)[0].text;
      expect(text).toContain("Reindexed");
      expect(text).toMatch(/\d+ notes/);
      expect(text).toMatch(/\d+ chunks/);
    });
  });

  describe("Write → Search round-trip", () => {
    it("should find a newly created note after reindex", async () => {
      await client.callTool({
        name: "create_note",
        arguments: {
          path: "round-trip-test.md",
          content: "Quantum computing breakthrough in superconducting qubits.",
          frontmatter: { tags: ["quantum"] },
        },
      });

      await client.callTool({ name: "reindex", arguments: {} });

      const result = await client.callTool({
        name: "search_semantic",
        arguments: { query: "quantum computing qubits", limit: 3 },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      expect(parsed.some((r: any) => r.path === "round-trip-test.md")).toBe(true);

      // Cleanup
      await client.callTool({
        name: "delete_note",
        arguments: { path: "round-trip-test.md", confirm: true },
      });
    });
  });
});
