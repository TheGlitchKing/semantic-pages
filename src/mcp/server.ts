import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Indexer } from "../core/indexer.js";
import { Embedder } from "../core/embedder.js";
import { GraphBuilder } from "../core/graph.js";
import { VectorIndex } from "../core/vector.js";
import { TextSearch } from "../core/search-text.js";
import { NoteCrud } from "../core/crud.js";
import { FrontmatterManager, TagManager } from "../core/frontmatter.js";
import { Watcher } from "../core/watcher.js";
import type { IndexedDocument, VaultStats } from "../core/types.js";

export async function createServer(notesPath: string, options: { watch?: boolean } = {}) {
  const indexPath = join(notesPath, ".semantic-pages-index");
  await mkdir(indexPath, { recursive: true });

  // Core services
  const indexer = new Indexer(notesPath);
  const embedder = new Embedder();
  const graph = new GraphBuilder();
  const textSearch = new TextSearch();
  const crud = new NoteCrud(notesPath);
  const frontmatterManager = new FrontmatterManager(notesPath);
  const tagManager = new TagManager(notesPath);

  let documents: IndexedDocument[] = [];
  let vectorIndex: VectorIndex | null = null;

  async function fullIndex() {
    await embedder.init();
    documents = await indexer.indexAll();
    textSearch.setDocuments(documents);
    graph.buildFromDocuments(documents);

    // Build vector index
    const allChunks: { embedding: Float32Array; docPath: string; chunkIndex: number; text: string }[] = [];
    for (const doc of documents) {
      const embeddings = await embedder.embedBatch(doc.chunks);
      for (let i = 0; i < embeddings.length; i++) {
        allChunks.push({
          embedding: embeddings[i],
          docPath: doc.path,
          chunkIndex: i,
          text: doc.chunks[i],
        });
      }
    }

    vectorIndex = new VectorIndex(embedder.getDimensions());
    vectorIndex.build(
      allChunks.map((c) => c.embedding),
      allChunks.map((c) => ({ docPath: c.docPath, chunkIndex: c.chunkIndex, text: c.text }))
    );

    // Persist
    await Promise.all([
      graph.save(indexPath),
      vectorIndex.save(indexPath),
      embedder.saveEmbeddings(
        new Map(allChunks.map((c) => [`${c.docPath}:${c.chunkIndex}`, c.embedding])),
        indexPath
      ),
    ]);
  }

  // MCP Server
  const server = new McpServer({
    name: "semantic-pages",
    version: "0.1.0",
  });

  // --- Search tools ---
  server.tool(
    "search_semantic",
    "Vector similarity search — find notes similar to a query by meaning",
    { query: z.string(), limit: z.number().optional().default(10) },
    async ({ query, limit }) => {
      if (!vectorIndex) return { content: [{ type: "text" as const, text: "Index not built. Run reindex first." }] };
      const queryEmbed = await embedder.embed(query);
      const results = vectorIndex.search(queryEmbed, limit);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "search_text",
    "Full-text keyword or regex search across all notes with optional filters",
    {
      pattern: z.string(),
      regex: z.boolean().optional().default(false),
      caseSensitive: z.boolean().optional().default(false),
      pathGlob: z.string().optional(),
      tagFilter: z.array(z.string()).optional(),
      limit: z.number().optional().default(20),
    },
    async (opts) => {
      const results = textSearch.search(opts);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "search_graph",
    "Graph traversal — find notes connected to a concept via wikilinks and tags",
    { concept: z.string(), maxDepth: z.number().optional().default(2) },
    async ({ concept, maxDepth }) => {
      const results = graph.searchGraph(concept, maxDepth);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "search_hybrid",
    "Combined semantic + graph search — vector results re-ranked by graph proximity",
    { query: z.string(), limit: z.number().optional().default(10) },
    async ({ query, limit }) => {
      if (!vectorIndex) return { content: [{ type: "text" as const, text: "Index not built. Run reindex first." }] };

      const queryEmbed = await embedder.embed(query);
      const semanticResults = vectorIndex.search(queryEmbed, limit * 2);
      const graphResults = graph.searchGraph(query, 2);
      const graphPaths = new Set(graphResults.map((r) => r.path));

      // Re-rank: boost semantic results that also appear in graph
      const hybrid = semanticResults.map((r) => ({
        ...r,
        score: graphPaths.has(r.path) ? r.score * 1.3 : r.score,
      }));
      hybrid.sort((a, b) => b.score - a.score);

      return { content: [{ type: "text" as const, text: JSON.stringify(hybrid.slice(0, limit), null, 2) }] };
    }
  );

  // --- Read tools ---
  server.tool(
    "read_note",
    "Read the full content of a specific note by path",
    { path: z.string() },
    async ({ path }) => {
      const content = await crud.read(path);
      return { content: [{ type: "text" as const, text: content }] };
    }
  );

  server.tool(
    "read_multiple_notes",
    "Batch read multiple notes in one call",
    { paths: z.array(z.string()) },
    async ({ paths }) => {
      const results = await crud.readMultiple(paths);
      const output: Record<string, string> = {};
      for (const [k, v] of results) output[k] = v;
      return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
    }
  );

  server.tool(
    "list_notes",
    "List all indexed notes with metadata (title, tags, link count)",
    {},
    async () => {
      const list = documents.map((d) => ({
        path: d.path,
        title: d.title,
        tags: d.tags,
        wikilinks: d.wikilinks.length,
        chunks: d.chunks.length,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
    }
  );

  // --- Write tools ---
  server.tool(
    "create_note",
    "Create a new markdown note",
    {
      path: z.string(),
      content: z.string(),
      frontmatter: z.record(z.unknown()).optional(),
    },
    async ({ path, content, frontmatter }) => {
      await crud.create(path, content, frontmatter);
      return { content: [{ type: "text" as const, text: `Created: ${path}` }] };
    }
  );

  server.tool(
    "update_note",
    "Edit note content — overwrite, append, prepend, or patch by heading",
    {
      path: z.string(),
      content: z.string(),
      mode: z.enum(["overwrite", "append", "prepend", "patch-by-heading"]),
      heading: z.string().optional(),
    },
    async ({ path, content, mode, heading }) => {
      await crud.update(path, content, { mode, heading });
      return { content: [{ type: "text" as const, text: `Updated: ${path} (${mode})` }] };
    }
  );

  server.tool(
    "delete_note",
    "Delete a note permanently",
    { path: z.string(), confirm: z.boolean().default(false) },
    async ({ path, confirm }) => {
      if (!confirm) return { content: [{ type: "text" as const, text: `Set confirm=true to delete ${path}` }] };
      await crud.delete(path);
      return { content: [{ type: "text" as const, text: `Deleted: ${path}` }] };
    }
  );

  server.tool(
    "move_note",
    "Move or rename a note — updates wikilinks across the vault",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      await crud.move(from, to);
      return { content: [{ type: "text" as const, text: `Moved: ${from} → ${to}` }] };
    }
  );

  // --- Metadata tools ---
  server.tool(
    "get_frontmatter",
    "Read parsed YAML frontmatter from a note as JSON",
    { path: z.string() },
    async ({ path }) => {
      const fm = await frontmatterManager.get(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(fm, null, 2) }] };
    }
  );

  server.tool(
    "update_frontmatter",
    "Set or delete YAML frontmatter keys — pass null to delete a key",
    { path: z.string(), fields: z.record(z.unknown()) },
    async ({ path, fields }) => {
      await frontmatterManager.update(path, fields);
      return { content: [{ type: "text" as const, text: `Frontmatter updated: ${path}` }] };
    }
  );

  server.tool(
    "manage_tags",
    "Add, remove, or list tags on a note (frontmatter and inline)",
    {
      path: z.string(),
      action: z.enum(["add", "remove", "list"]),
      tags: z.array(z.string()).optional(),
    },
    async ({ path, action, tags }) => {
      switch (action) {
        case "list": {
          const result = await tagManager.list(path);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }
        case "add": {
          if (!tags?.length) return { content: [{ type: "text" as const, text: "No tags provided" }] };
          await tagManager.add(path, tags);
          return { content: [{ type: "text" as const, text: `Added tags to ${path}: ${tags.join(", ")}` }] };
        }
        case "remove": {
          if (!tags?.length) return { content: [{ type: "text" as const, text: "No tags provided" }] };
          await tagManager.remove(path, tags);
          return { content: [{ type: "text" as const, text: `Removed tags from ${path}: ${tags.join(", ")}` }] };
        }
      }
    }
  );

  server.tool(
    "rename_tag",
    "Rename a tag across all notes in the vault",
    { oldTag: z.string(), newTag: z.string() },
    async ({ oldTag, newTag }) => {
      const count = await tagManager.renameVaultWide(oldTag, newTag);
      return { content: [{ type: "text" as const, text: `Renamed #${oldTag} → #${newTag} in ${count} files` }] };
    }
  );

  // --- Graph tools ---
  server.tool(
    "backlinks",
    "Find all notes that link TO a given note",
    { path: z.string() },
    async ({ path }) => {
      const results = graph.backlinks(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "forwardlinks",
    "Find all notes linked FROM a given note",
    { path: z.string() },
    async ({ path }) => {
      const results = graph.forwardlinks(path);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "graph_path",
    "Find the shortest path between two notes in the knowledge graph",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      const path = graph.findPath(from, to);
      if (!path) return { content: [{ type: "text" as const, text: "No path found" }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(path) }] };
    }
  );

  server.tool(
    "graph_statistics",
    "Knowledge graph stats — most connected nodes, orphans, density",
    {},
    async () => {
      const stats = graph.statistics();
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  // --- System tools ---
  server.tool(
    "get_stats",
    "Vault and index statistics — note count, chunks, embeddings, graph density",
    {},
    async () => {
      const graphStats = graph.statistics();
      const stats: VaultStats = {
        totalNotes: documents.length,
        totalChunks: documents.reduce((n, d) => n + d.chunks.length, 0),
        totalEmbeddings: vectorIndex?.getChunkMeta().length ?? 0,
        embeddingDimensions: embedder.getDimensions(),
        embeddingModel: embedder.getModel(),
        graphNodes: graphStats.totalNodes,
        graphEdges: graphStats.totalEdges,
        indexSize: 0,
        lastIndexed: new Date().toISOString(),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  server.tool(
    "reindex",
    "Force a full reindex of the vault",
    {},
    async () => {
      await fullIndex();
      return {
        content: [
          {
            type: "text" as const,
            text: `Reindexed: ${documents.length} notes, ${documents.reduce((n, d) => n + d.chunks.length, 0)} chunks`,
          },
        ],
      };
    }
  );

  // Initial index
  await fullIndex();

  // File watcher
  if (options.watch !== false) {
    const watcher = new Watcher(notesPath);
    watcher.on("changed", async () => {
      await fullIndex();
    });
    watcher.start();
  }

  return server;
}

export async function startServer(notesPath: string, options: { watch?: boolean } = {}) {
  const server = await createServer(notesPath, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
