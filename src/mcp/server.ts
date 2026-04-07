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
  workers?: number;
  batchSize?: number;
  quantized?: boolean;
  onProgress?: (embedded: number, total: number) => void;
}

export async function createServer(notesPath: string, options: ServerOptions = {}) {
  const indexPath = join(notesPath, ".semantic-pages-index");
  await mkdir(indexPath, { recursive: true });

  // Core services
  const indexer = new Indexer(notesPath);
  const embedder = new Embedder(options.model, options.workers, options.batchSize, options.quantized);
  const graph = new GraphBuilder();
  const textSearch = new TextSearch();
  const crud = new NoteCrud(notesPath);
  const frontmatterManager = new FrontmatterManager(notesPath);
  const tagManager = new TagManager(notesPath);

  let documents: IndexedDocument[] = [];
  let docByPath = new Map<string, IndexedDocument>();
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
      docByPath = new Map(documents.map((d) => [d.path, d]));
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

    // Collect ALL pending chunks across ALL docs first so embedBatch can use full batch_size
    type PendingChunk = { text: string; docPath: string; chunkIndex: number };
    const pendingChunks: PendingChunk[] = [];

    for (const doc of newDocs) {
      for (let i = 0; i < doc.chunks.length; i++) {
        const key = `${doc.path}:${i}`;
        const existing = cumulativeEmbeddings.get(key);
        if (existing) {
          allChunks.push({ embedding: existing, docPath: doc.path, chunkIndex: i, text: doc.chunks[i] });
        } else {
          pendingChunks.push({ text: doc.chunks[i], docPath: doc.path, chunkIndex: i });
        }
      }
    }

    // Seed progress with already-embedded chunks
    indexProgress = { embedded: allChunks.length, total: totalChunks };

    if (pendingChunks.length > 0) {
      let chunksSinceLastSave = 0;
      const alreadyEmbedded = allChunks.length;

      await embedder.embedBatch(
        pendingChunks.map((c) => c.text),
        async (done, _total, embeddings) => {
          // embeddings contains the just-completed sub-batch
          if (!embeddings) return;
          const batchStart = done - embeddings.length;
          for (let i = 0; i < embeddings.length; i++) {
            const { docPath, chunkIndex, text } = pendingChunks[batchStart + i];
            const key = `${docPath}:${chunkIndex}`;
            cumulativeEmbeddings.set(key, embeddings[i]);
            allChunks.push({ embedding: embeddings[i], docPath, chunkIndex, text });
            chunksSinceLastSave++;
          }

          const current = alreadyEmbedded + done;
          indexProgress = { embedded: current, total: totalChunks };
          options.onProgress?.(current, totalChunks);

          if (chunksSinceLastSave >= SAVE_INTERVAL) {
            await embedder.saveEmbeddings(cumulativeEmbeddings, indexPath);
            chunksSinceLastSave = 0;
          }
        }
      );
    }

    const newVector = new VectorIndex(embedder.getDimensions());
    newVector.build(
      allChunks.map((c) => c.embedding),
      allChunks.map((c) => ({ docPath: c.docPath, chunkIndex: c.chunkIndex, text: c.text }))
    );

    // Atomic swap — all state updated together
    documents = newDocs;
    docByPath = new Map(documents.map((d) => [d.path, d]));
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

  // --- Result enrichment & filtering helpers ---

  /** Attach mtime and optional frontmatter metadata from the live document index */
  function enrichResult<T extends { path: string }>(result: T): T & {
    mtime?: string;
    loadPriority?: number;
    status?: string;
    tier?: string;
    domains?: string[];
  } {
    const doc = docByPath.get(result.path);
    if (!doc) return result;
    return {
      ...result,
      mtime: doc.mtime,
      ...(doc.loadPriority !== undefined && { loadPriority: doc.loadPriority }),
      ...(doc.status !== undefined && { status: doc.status }),
      ...(doc.tier !== undefined && { tier: doc.tier }),
      ...(doc.domains !== undefined && { domains: doc.domains }),
    };
  }

  /**
   * Boost score by load_priority (1-10).
   * A priority-10 doc gets +20% on top of its semantic score;
   * priority-1 gets -18%. Docs without load_priority are unaffected.
   */
  function applyPriorityBoost(score: number, path: string): number {
    const doc = docByPath.get(path);
    if (doc?.loadPriority === undefined) return score;
    return score * (1 + (doc.loadPriority - 5) * 0.04);
  }

  /** Filter results by optional ISO date window (modifiedAfter / modifiedBefore) */
  function applyDateFilter<T extends { path: string }>(
    results: T[],
    modifiedAfter?: string,
    modifiedBefore?: string
  ): T[] {
    if (!modifiedAfter && !modifiedBefore) return results;
    const after = modifiedAfter ? new Date(modifiedAfter).getTime() : -Infinity;
    const before = modifiedBefore ? new Date(modifiedBefore).getTime() : Infinity;
    return results.filter((r) => {
      const doc = docByPath.get(r.path);
      if (!doc) return true; // don't drop results we can't check
      const t = new Date(doc.mtime).getTime();
      return t >= after && t <= before;
    });
  }

  // MCP Server
  const server = new McpServer({
    name: "semantic-pages",
    version: "0.2.0",
  });

  // --- Search tools ---
  server.tool(
    "search_semantic",
    "Vector similarity search — find notes similar to a query by meaning. Scores are boosted by load_priority when present.",
    {
      query: z.string(),
      limit: z.number().optional().default(10),
      modifiedAfter: z.string().optional().describe("ISO date — only return notes modified after this date (e.g. '2026-01-01')"),
      modifiedBefore: z.string().optional().describe("ISO date — only return notes modified before this date"),
      status: z.string().optional().describe("Filter by frontmatter status (e.g. 'active', 'draft')"),
      tier: z.string().optional().describe("Filter by frontmatter tier (e.g. 'guide', 'reference')"),
      domain: z.string().optional().describe("Filter by frontmatter domain (e.g. 'api', 'security')"),
    },
    async ({ query, limit, modifiedAfter, modifiedBefore, status, tier, domain }) => {
      if (!vectorIndex) return textResponse(indexState === "empty" ? indexingMessage() : "Index not built. Run reindex first.");
      const queryEmbed = await embedder.embed(query);
      // Fetch extra results to compensate for post-filtering
      let results = vectorIndex.search(queryEmbed, limit * 3);
      // Apply load_priority boost then re-sort
      results = results.map((r) => ({ ...r, score: applyPriorityBoost(r.score, r.path) }));
      results.sort((a, b) => b.score - a.score);
      // Date + metadata filters
      results = applyDateFilter(results, modifiedAfter, modifiedBefore);
      if (status) results = results.filter((r) => docByPath.get(r.path)?.status === status);
      if (tier) results = results.filter((r) => docByPath.get(r.path)?.tier === tier);
      if (domain) results = results.filter((r) => docByPath.get(r.path)?.domains?.includes(domain));
      const enriched = results.slice(0, limit).map(enrichResult);
      return textResponse(JSON.stringify(enriched, null, 2));
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
      modifiedAfter: z.string().optional().describe("ISO date — only return notes modified after this date"),
      modifiedBefore: z.string().optional().describe("ISO date — only return notes modified before this date"),
      status: z.string().optional().describe("Filter by frontmatter status"),
      tier: z.string().optional().describe("Filter by frontmatter tier"),
      domain: z.string().optional().describe("Filter by frontmatter domain"),
    },
    async ({ modifiedAfter, modifiedBefore, status, tier, domain, ...opts }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      let results = textSearch.search(opts);
      results = applyDateFilter(results, modifiedAfter, modifiedBefore);
      if (status) results = results.filter((r) => docByPath.get(r.path)?.status === status);
      if (tier) results = results.filter((r) => docByPath.get(r.path)?.tier === tier);
      if (domain) results = results.filter((r) => docByPath.get(r.path)?.domains?.includes(domain));
      const enriched = results.map(enrichResult);
      return textResponse(JSON.stringify(enriched, null, 2));
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
    "Combined semantic + graph search — vector results re-ranked by graph proximity and load_priority",
    {
      query: z.string(),
      limit: z.number().optional().default(10),
      modifiedAfter: z.string().optional().describe("ISO date — only return notes modified after this date"),
      modifiedBefore: z.string().optional().describe("ISO date — only return notes modified before this date"),
      status: z.string().optional().describe("Filter by frontmatter status"),
      tier: z.string().optional().describe("Filter by frontmatter tier"),
      domain: z.string().optional().describe("Filter by frontmatter domain"),
    },
    async ({ query, limit, modifiedAfter, modifiedBefore, status, tier, domain }) => {
      if (!vectorIndex) return textResponse(indexState === "empty" ? indexingMessage() : "Index not built. Run reindex first.");

      const queryEmbed = await embedder.embed(query);
      const semanticResults = vectorIndex.search(queryEmbed, limit * 3);
      const graphResults = graph.searchGraph(query, 2);
      const graphPaths = new Set(graphResults.map((r) => r.path));

      // Re-rank: graph proximity + load_priority boost
      let hybrid = semanticResults.map((r) => ({
        ...r,
        score: applyPriorityBoost(
          graphPaths.has(r.path) ? r.score * 1.3 : r.score,
          r.path
        ),
      }));
      hybrid.sort((a, b) => b.score - a.score);

      hybrid = applyDateFilter(hybrid, modifiedAfter, modifiedBefore);
      if (status) hybrid = hybrid.filter((r) => docByPath.get(r.path)?.status === status);
      if (tier) hybrid = hybrid.filter((r) => docByPath.get(r.path)?.tier === tier);
      if (domain) hybrid = hybrid.filter((r) => docByPath.get(r.path)?.domains?.includes(domain));

      const enriched = hybrid.slice(0, limit).map(enrichResult);
      return textResponse(JSON.stringify(enriched, null, 2));
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
    "List all indexed notes with metadata (title, tags, timestamps, link count). Supports filtering by date, status, tier, and domain.",
    {
      modifiedAfter: z.string().optional().describe("ISO date — only return notes modified after this date (e.g. '2026-01-01')"),
      modifiedBefore: z.string().optional().describe("ISO date — only return notes modified before this date"),
      status: z.string().optional().describe("Filter by frontmatter status (e.g. 'active', 'deprecated')"),
      tier: z.string().optional().describe("Filter by frontmatter tier (e.g. 'guide', 'reference')"),
      domain: z.string().optional().describe("Filter by frontmatter domain (e.g. 'api', 'security')"),
    },
    async ({ modifiedAfter, modifiedBefore, status, tier, domain }) => {
      if (documents.length === 0 && indexState !== "ready") return textResponse(indexingMessage());
      const after = modifiedAfter ? new Date(modifiedAfter).getTime() : -Infinity;
      const before = modifiedBefore ? new Date(modifiedBefore).getTime() : Infinity;

      let list = documents
        .filter((d) => {
          const t = new Date(d.mtime).getTime();
          if (t < after || t > before) return false;
          if (status && d.status !== status) return false;
          if (tier && d.tier !== tier) return false;
          if (domain && !d.domains?.includes(domain)) return false;
          return true;
        })
        .map((d) => ({
          path: d.path,
          title: d.title,
          mtime: d.mtime,
          tags: d.tags,
          wikilinks: d.wikilinks.length,
          chunks: d.chunks.length,
          ...(d.loadPriority !== undefined && { loadPriority: d.loadPriority }),
          ...(d.status !== undefined && { status: d.status }),
          ...(d.tier !== undefined && { tier: d.tier }),
          ...(d.domains !== undefined && { domains: d.domains }),
          ...(d.purpose !== undefined && { purpose: d.purpose }),
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

  // --- Startup ---
  if (options.waitForReady) {
    // Blocking mode (CLI --reindex): load model + do full index before returning
    await tryLoadCachedIndex();
    await fullIndex();
  } else {
    // MCP serve mode: return the server immediately so the transport can connect.
    // Model load + cache load happen in background — tools return "Indexing in
    // progress" until ready. This prevents MCP client timeout on slow machines.
    tryLoadCachedIndex()
      .then((cached) => {
        if (!cached) backgroundIndex();
      })
      .catch((err) => {
        process.stderr.write(`Startup error: ${err?.message ?? err}\n`);
        backgroundIndex();
      });
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
