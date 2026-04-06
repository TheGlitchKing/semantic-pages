import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import type { IndexedDocument, IndexState, VaultStats } from "../core/types.js";

export interface ServerOptions {
  watch?: boolean;
  waitForReady?: boolean;
  model?: string;
  onProgress?: (embedded: number, total: number) => void;
}

export async function createServer(notesPath: string, options: ServerOptions = {}) {
  const indexPath = join(notesPath, ".semantic-pages-index");
  await mkdir(indexPath, { recursive: true });

  // Core services
  const indexer = new Indexer(notesPath);
  const embedder = new Embedder(options.model);
  const graph = new GraphBuilder();
  const textSearch = new TextSearch();
  const crud = new NoteCrud(notesPath);
  const frontmatterManager = new FrontmatterManager(notesPath);
  const tagManager = new TagManager(notesPath);

  let documents: IndexedDocument[] = [];
  let vectorIndex: VectorIndex | null = null;
  let indexState: IndexState = "empty";
  let indexProgress = { embedded: 0, total: 0 };
  let indexingPromise: Promise<void> | null = null;

  async function tryLoadCachedIndex(): Promise<boolean> {
    try {
      indexState = "loading";
      await embedder.init();

      // Check for model mismatch — if model changed, cached embeddings are invalid
      const metaPath = join(indexPath, "meta.json");
      if (existsSync(metaPath)) {
        const meta = JSON.parse(await readFile(metaPath, "utf-8"));
        if (meta.model && meta.model !== embedder.getModel()) {
          process.stderr.write(`Model changed (${meta.model} → ${embedder.getModel()}), forcing reindex\n`);
          return false;
        }
      }

      const tempVector = new VectorIndex(embedder.getDimensions());
      const vectorLoaded = await tempVector.load(indexPath);
      if (!vectorLoaded) return false;

      const savedEmbeddings = await embedder.loadEmbeddings(indexPath);
      if (savedEmbeddings.size === 0) return false;

      const graphLoaded = await graph.load(indexPath);
      if (!graphLoaded) return false;

      documents = await indexer.indexAll();
      textSearch.setDocuments(documents);

      vectorIndex = tempVector;
      indexState = "stale";
      return true;
    } catch {
      return false;
    }
  }

  async function fullIndex() {
    indexState = "indexing";
    indexProgress = { embedded: 0, total: 0 };

    await embedder.init();
    const newDocs = await indexer.indexAll();

    // Count total chunks for progress
    const totalChunks = newDocs.reduce((n, d) => n + d.chunks.length, 0);
    indexProgress = { embedded: 0, total: totalChunks };

    // Build text search and graph immediately (fast, no embeddings needed)
    const newTextSearch = new TextSearch();
    newTextSearch.setDocuments(newDocs);

    const newGraph = new GraphBuilder();
    newGraph.buildFromDocuments(newDocs);

    // Try to resume from partially saved embeddings (crash recovery)
    const savedEmbeddings = await embedder.loadEmbeddings(indexPath);

    // Build vector index (slow — embedding)
    const SAVE_INTERVAL = 100;
    const allChunks: { embedding: Float32Array; docPath: string; chunkIndex: number; text: string }[] = [];
    const cumulativeEmbeddings = new Map<string, Float32Array>(savedEmbeddings);
    let chunksSinceLastSave = 0;

    for (const doc of newDocs) {
      // Check which chunks already have saved embeddings
      const chunksToEmbed: { text: string; index: number }[] = [];
      for (let i = 0; i < doc.chunks.length; i++) {
        const key = `${doc.path}:${i}`;
        const existing = cumulativeEmbeddings.get(key);
        if (existing) {
          allChunks.push({ embedding: existing, docPath: doc.path, chunkIndex: i, text: doc.chunks[i] });
        } else {
          chunksToEmbed.push({ text: doc.chunks[i], index: i });
        }
      }

      if (chunksToEmbed.length > 0) {
        const embeddings = await embedder.embedBatch(
          chunksToEmbed.map((c) => c.text),
          (done, _total) => {
            const current = allChunks.length + done;
            indexProgress = { embedded: current, total: totalChunks };
            options.onProgress?.(current, totalChunks);
          }
        );
        for (let i = 0; i < embeddings.length; i++) {
          const { index, text } = chunksToEmbed[i];
          const key = `${doc.path}:${index}`;
          cumulativeEmbeddings.set(key, embeddings[i]);
          allChunks.push({ embedding: embeddings[i], docPath: doc.path, chunkIndex: index, text });
          chunksSinceLastSave++;
        }
      }

      indexProgress = { embedded: allChunks.length, total: totalChunks };

      // Incremental save every SAVE_INTERVAL new chunks
      if (chunksSinceLastSave >= SAVE_INTERVAL) {
        await embedder.saveEmbeddings(cumulativeEmbeddings, indexPath);
        chunksSinceLastSave = 0;
      }
    }

    const newVector = new VectorIndex(embedder.getDimensions());
    newVector.build(
      allChunks.map((c) => c.embedding),
      allChunks.map((c) => ({ docPath: c.docPath, chunkIndex: c.chunkIndex, text: c.text }))
    );

    // Atomic swap — all state updated together
    documents = newDocs;
    textSearch.setDocuments(newDocs);
    graph.buildFromDocuments(newDocs);
    vectorIndex = newVector;
    indexState = "ready";

    // Final persist
    await Promise.all([
      graph.save(indexPath),
      newVector.save(indexPath),
      embedder.saveEmbeddings(cumulativeEmbeddings, indexPath),
      writeFile(join(indexPath, "meta.json"), JSON.stringify({
        model: embedder.getModel(),
        dimensions: embedder.getDimensions(),
        totalChunks: allChunks.length,
        indexedAt: new Date().toISOString(),
      })),
    ]);
  }

  function backgroundIndex() {
    if (indexingPromise) return; // already indexing
    indexingPromise = fullIndex()
      .catch((err) => {
        process.stderr.write(`Index error: ${err?.message ?? err}\n`);
        if (indexState === "indexing") indexState = documents.length > 0 ? "stale" : "empty";
      })
      .finally(() => {
        indexingPromise = null;
      });
  }

  function textResponse(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  function indexingMessage(): string {
    if (indexProgress.total > 0) {
      return `Indexing in progress (${indexProgress.embedded}/${indexProgress.total} chunks)... Try again shortly.`;
    }
    return "Indexing in progress... Try again shortly.";
  }

  // MCP Server
  const server = new McpServer({
    name: "semantic-pages",
    version: "0.2.0",
  });

  // --- Search tools ---
  server.tool(
    "search_semantic",
    "Vector similarity search — find notes similar to a query by meaning",
    { query: z.string(), limit: z.number().optional().default(10) },
    async ({ query, limit }) => {
      if (!vectorIndex) return textResponse(indexState === "empty" ? indexingMessage() : "Index not built. Run reindex first.");
      const queryEmbed = await embedder.embed(query);
      const results = vectorIndex.search(queryEmbed, limit);
      return textResponse(JSON.stringify(results, null, 2));
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
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const results = textSearch.search(opts);
      return textResponse(JSON.stringify(results, null, 2));
    }
  );

  server.tool(
    "search_graph",
    "Graph traversal — find notes connected to a concept via wikilinks and tags",
    { concept: z.string(), maxDepth: z.number().optional().default(2) },
    async ({ concept, maxDepth }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const results = graph.searchGraph(concept, maxDepth);
      return textResponse(JSON.stringify(results, null, 2));
    }
  );

  server.tool(
    "search_hybrid",
    "Combined semantic + graph search — vector results re-ranked by graph proximity",
    { query: z.string(), limit: z.number().optional().default(10) },
    async ({ query, limit }) => {
      if (!vectorIndex) return textResponse(indexState === "empty" ? indexingMessage() : "Index not built. Run reindex first.");

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

      return textResponse(JSON.stringify(hybrid.slice(0, limit), null, 2));
    }
  );

  // --- Read tools ---
  server.tool(
    "read_note",
    "Read the full content of a specific note by path",
    { path: z.string() },
    async ({ path }) => {
      const content = await crud.read(path);
      return textResponse(content);
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
      return textResponse(JSON.stringify(output, null, 2));
    }
  );

  server.tool(
    "list_notes",
    "List all indexed notes with metadata (title, tags, link count)",
    {},
    async () => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const list = documents.map((d) => ({
        path: d.path,
        title: d.title,
        tags: d.tags,
        wikilinks: d.wikilinks.length,
        chunks: d.chunks.length,
      }));
      return textResponse(JSON.stringify(list, null, 2));
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
      return textResponse(`Created: ${path}`);
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
      return textResponse(`Updated: ${path} (${mode})`);
    }
  );

  server.tool(
    "delete_note",
    "Delete a note permanently",
    { path: z.string(), confirm: z.boolean().default(false) },
    async ({ path, confirm }) => {
      if (!confirm) return textResponse(`Set confirm=true to delete ${path}`);
      await crud.delete(path);
      return textResponse(`Deleted: ${path}`);
    }
  );

  server.tool(
    "move_note",
    "Move or rename a note — updates wikilinks across the vault",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      await crud.move(from, to);
      return textResponse(`Moved: ${from} → ${to}`);
    }
  );

  // --- Metadata tools ---
  server.tool(
    "get_frontmatter",
    "Read parsed YAML frontmatter from a note as JSON",
    { path: z.string() },
    async ({ path }) => {
      const fm = await frontmatterManager.get(path);
      return textResponse(JSON.stringify(fm, null, 2));
    }
  );

  server.tool(
    "update_frontmatter",
    "Set or delete YAML frontmatter keys — pass null to delete a key",
    { path: z.string(), fields: z.record(z.unknown()) },
    async ({ path, fields }) => {
      await frontmatterManager.update(path, fields);
      return textResponse(`Frontmatter updated: ${path}`);
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
          return textResponse(JSON.stringify(result));
        }
        case "add": {
          if (!tags?.length) return textResponse("No tags provided");
          await tagManager.add(path, tags);
          return textResponse(`Added tags to ${path}: ${tags.join(", ")}`);
        }
        case "remove": {
          if (!tags?.length) return textResponse("No tags provided");
          await tagManager.remove(path, tags);
          return textResponse(`Removed tags from ${path}: ${tags.join(", ")}`);
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
      return textResponse(`Renamed #${oldTag} → #${newTag} in ${count} files`);
    }
  );

  // --- Graph tools ---
  server.tool(
    "backlinks",
    "Find all notes that link TO a given note",
    { path: z.string() },
    async ({ path }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const results = graph.backlinks(path);
      return textResponse(JSON.stringify(results, null, 2));
    }
  );

  server.tool(
    "forwardlinks",
    "Find all notes linked FROM a given note",
    { path: z.string() },
    async ({ path }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const results = graph.forwardlinks(path);
      return textResponse(JSON.stringify(results, null, 2));
    }
  );

  server.tool(
    "graph_path",
    "Find the shortest path between two notes in the knowledge graph",
    { from: z.string(), to: z.string() },
    async ({ from, to }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const path = graph.findPath(from, to);
      if (!path) return textResponse("No path found");
      return textResponse(JSON.stringify(path));
    }
  );

  server.tool(
    "graph_statistics",
    "Knowledge graph stats — most connected nodes, orphans, density",
    {},
    async () => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const stats = graph.statistics();
      return textResponse(JSON.stringify(stats, null, 2));
    }
  );

  // --- System tools ---
  server.tool(
    "get_stats",
    "Vault and index statistics — note count, chunks, embeddings, graph density",
    {},
    async () => {
      const graphStats = documents.length > 0 ? graph.statistics() : { totalNodes: 0, totalEdges: 0 };
      const stats: VaultStats = {
        totalNotes: documents.length,
        totalChunks: documents.reduce((n, d) => n + d.chunks.length, 0),
        totalEmbeddings: vectorIndex?.getChunkMeta().length ?? 0,
        embeddingDimensions: embedder.getDimensions(),
        embeddingModel: embedder.getModel(),
        embeddingRuntime: embedder.getRuntime?.() ?? "unknown",
        graphNodes: graphStats.totalNodes,
        graphEdges: graphStats.totalEdges,
        indexSize: 0,
        lastIndexed: indexState === "ready" ? new Date().toISOString() : null,
        indexState,
        indexProgress: indexState === "indexing" ? indexProgress : undefined,
      };
      return textResponse(JSON.stringify(stats, null, 2));
    }
  );

  server.tool(
    "reindex",
    "Force a full reindex of the vault",
    {},
    async () => {
      if (indexingPromise) return textResponse("Reindex already in progress. " + indexingMessage());
      await fullIndex();
      return textResponse(
        `Reindexed: ${documents.length} notes, ${documents.reduce((n, d) => n + d.chunks.length, 0)} chunks`
      );
    }
  );

  // --- Startup: load cached index, then reindex ---
  const cached = await tryLoadCachedIndex();
  if (options.waitForReady) {
    // Blocking mode (CLI --reindex): wait for full index before returning
    await fullIndex();
  } else {
    // Non-blocking mode (MCP server): index in background
    backgroundIndex();
  }

  // File watcher
  if (options.watch !== false) {
    const watcher = new Watcher(notesPath);
    watcher.on("changed", () => {
      backgroundIndex();
    });
    watcher.start();
  }

  return server;
}

export async function startServer(notesPath: string, options: ServerOptions = {}) {
  const server = await createServer(notesPath, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
