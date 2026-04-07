# How Semantic Pages Works

## Overview

Semantic Pages runs as an MCP (Model Context Protocol) server that sits between your AI assistant and a folder of markdown files. It maintains three persistent indexes — a vector store, a knowledge graph, and a full-text engine — and exposes them as 21 tools. Everything runs locally over stdio. No network calls after the first model download, no background daemons, no Docker.

---

## Startup Sequence

When the server starts (`npx @theglitchking/semantic-pages --notes ./vault`):

```
1. Load ONNX runtime (native C++ preferred, WASM fallback)
2. Try to load cached index from .semantic-pages-index/
   a. If cache found and model matches → load instantly, serve immediately
   b. If no cache or model mismatch → start full index in background
3. Connect MCP transport (stdio)
4. Start file watcher (unless --no-watch)
```

The server is immediately available for tool calls even while indexing is in progress. Search tools return an "Indexing in progress (N/M chunks)" message until the index is ready. Non-search tools (read, write, frontmatter) work immediately.

On subsequent starts with a warm cache, the server is ready in under a second.

---

## Document Processing Pipeline

### Step 1: Parse

Each `.md` file is processed by `src/core/indexer.ts`:

```
file → gray-matter → extracts YAML frontmatter (title, tags, date, etc.)
     → remark + remark-wiki-link → AST traversal extracts:
         - title (frontmatter.title > first H1 > filename)
         - [[wikilinks]] (resolved to relative paths)
         - #tags (inline + frontmatter tags: array)
         - heading structure (H1–H6)
         - plain text (markdown stripped, code blocks preserved)
```

### Step 2: Chunk

The plain text is split into overlapping chunks of ~512 tokens at sentence boundaries. Each chunk carries its parent document path and chunk index so results can be traced back to source files.

### Step 3: Embed

`src/core/embedder.ts` runs local inference:

```
texts[] → tokenize individually (HuggingFace fast tokenizer)
        → pad to batch's max seq_len → [batch, seq_len] tensors
        → ONNX InferenceSession.run() → [batch, seq_len, hidden_size]
        → mean pooling with attention mask
        → L2 normalize
        → Float32Array[] (one vector per chunk)
```

This happens in sub-batches (default 16 texts per ONNX call). See [Performance Tuning](./performance-tuning.md) for why batch size matters.

### Step 4: Index

Two indexes are built simultaneously:

**Vector index** (`src/core/vector.ts`):
- HNSW (Hierarchical Navigable Small World) algorithm via `hnswlib-node`
- Same algorithm used by Pinecone, Weaviate, and pgvector
- Approximate nearest neighbor — finds the top-K most similar vectors in O(log n)
- Serialized to `hnsw.bin` + `hnsw-meta.json`

**Knowledge graph** (`src/core/graph.ts`):
- Directed graph via `graphology`
- Nodes: individual notes (by path)
- Edges: `[[wikilinks]]` + shared `#tags`
- Enables: backlinks, forwardlinks, shortest path, BFS traversal
- Serialized to `graph.json`

### Step 5: Persist

```
.semantic-pages-index/
├── embeddings.json     — chunk key → Float32Array (used for resume/crash recovery)
├── hnsw.bin            — HNSW graph structure (binary)
├── hnsw-meta.json      — chunk index → {docPath, chunkIndex, text}
├── graph.json          — graphology serialized graph
└── meta.json           — {model, dimensions, totalChunks, indexedAt}
```

The `meta.json` model field is checked on startup. If the model changed (e.g., you upgraded and the default changed), the cache is discarded and a full reindex runs.

---

## Search Mechanics

### Semantic Search (`search_semantic`)

```
query string → embed with same model → query vector
             → HNSW.searchKnn(queryVec, k) → top-k chunk indices
             → resolve chunk indices → {path, chunkIndex, text, score}
```

Returns chunks, not whole documents. A single document may appear multiple times if several of its chunks match. Results are ordered by cosine similarity (higher = more similar).

### Text Search (`search_text`)

Scans all document text using in-memory string matching or `RegExp`. Supports:
- Case-sensitive/insensitive
- Regex patterns
- Path glob filtering (`pathGlob: "devops/**"`)
- Tag filtering (`tagFilter: ["kubernetes"]`)

This is the tool to use when you need exact matches, not "meaning."

### Graph Search (`search_graph`)

```
concept string → text-match notes with that concept
              → BFS traversal from matching nodes (up to maxDepth hops)
              → collect all visited nodes
              → return sorted by distance from start
```

Edges are: explicit `[[wikilinks]]` and co-occurrence of `#tags` (notes sharing a tag are considered connected).

### Hybrid Search (`search_hybrid`)

```
query → semantic search → scored results
      → graph search   → connected set
      → re-rank: boost semantic score for results also in the graph neighborhood
      → return combined ranking
```

Useful for "find everything relevant to X" queries where you want both topically similar notes and structurally connected ones.

---

## File Watcher

`src/core/watcher.ts` uses `chokidar` to watch the notes directory. On any file change (add/modify/delete), a debounced `backgroundIndex()` call runs. This re-parses all documents and re-embeds any chunks that don't already have embeddings in the saved `embeddings.json`.

Because embeddings are saved incrementally (every 100 new chunks), most of the work is skipped on incremental updates — only the changed file's chunks need to be re-embedded.

---

## Incremental Save and Crash Recovery

During initial indexing of a large vault, embeddings are saved every 100 chunks to `embeddings.json`. If the process is killed mid-index (e.g., `Ctrl+C`), the next `--reindex` run loads the partial `embeddings.json` and skips already-embedded chunks. Only unembedded chunks are sent through the ONNX model.

---

## Concurrency Model

The server is single-threaded (one Node.js process). ONNX inference is synchronous per batch — no parallel ONNX calls. The `--workers N` flag exists for worker-thread parallelism but is disabled by default because:
- Each worker loads its own ONNX session (~22MB for MiniLM, ~137MB for nomic)
- On machines with limited RAM, parallel workers cause more cache misses, not fewer
- The default MiniLM model is fast enough that serial inference completes in ~3–5 minutes for typical vaults

If you have a large vault (10,000+ notes) and ample RAM (>8GB free), `--workers 2` may help. See [Performance Tuning](./performance-tuning.md).
