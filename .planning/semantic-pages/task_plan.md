# semantic-pages

> Semantic search + knowledge graph MCP server for any folder of markdown files.
> Installable as a single npm package. No Docker. No Python. No Obsidian required.
> Works with any repo, any project, any markdown knowledge base.

---

## Status

- [ ] Phase 1 — Project scaffold
- [ ] Phase 2 — Markdown indexer
- [ ] Phase 3 — Embedding engine
- [ ] Phase 4 — Knowledge graph
- [ ] Phase 5 — Vector & text search
- [ ] Phase 6 — CRUD operations
- [ ] Phase 7 — Frontmatter & tag management
- [ ] Phase 8 — MCP server
- [ ] Phase 9 — File watcher
- [ ] Phase 10 — Testing & QA
- [ ] Phase 11 — CLI + npm package
- [ ] Phase 12 — Glitch Kingdom marketplace publishing

---

## Goal

Give Claude the full Obsidian vault experience — semantic search + knowledge graph — over
any folder of markdown files in any repo, without Obsidian, Docker, Python, or a GUI.

**Per-repo pattern:**
```
any-repo/
├── notes/          ← markdown files, committed to git
├── .mcp.json       ← "semantic-pages": { "--notes": "./notes" }
└── .semantic-pages-index/    ← gitignored, auto-rebuilt
```

`cd any-repo && claude` → Claude immediately has semantic search + graph over that repo's notes.
Each repo gets its own independent knowledge base. No shared state between projects.

**What semantic-pages replaces (for Claude):**

| Obsidian + Smart Connections + mcp-tools | semantic-pages |
|---|---|
| Semantic search over notes | `search_semantic` |
| Knowledge graph traversal | `search_graph` |
| Hybrid search (vector + graph) | `search_hybrid` |
| Full-text / regex search | `search_text` |
| Read a note | `read_note` |
| Read multiple notes | `read_multiple_notes` |
| List all notes | `list_notes` |
| Create a note | `create_note` |
| Update a note | `update_note` |
| Delete a note | `delete_note` |
| Move / rename a note | `move_note` |
| Get / update frontmatter | `get_frontmatter` / `update_frontmatter` |
| Manage tags | `manage_tags` |
| Backlinks / forwardlinks | `backlinks` / `forwardlinks` |
| Graph path & statistics | `graph_path` / `graph_statistics` |
| Vault / index stats | `get_stats` |
| Auto-reindex on file save | file watcher |

**What semantic-pages does NOT replace (human UI):**
- Visual graph view — still use Obsidian or Obsidian.md for that
- Note editor — use any editor (VS Code, Obsidian, Neovim, etc.)

`npx semantic-pages --notes <path>` gives Claude:

- Semantic similarity search over markdown notes
- Knowledge graph traversal (entities, relationships, wikilinks)
- Hybrid search (vector + graph combined)
- Incremental re-indexing when vault files change
- Index stored as local files in `.semantic-pages-index/` alongside the notes (gitignored, rebuilt on demand)
- `--notes` flag accepts any path — `./vault`, `./docs`, `./notes`, `.` (whole repo)

---

## Tech Stack

| Concern | Package | Notes |
|---|---|---|
| Markdown parsing | `unified` + `remark-parse` | AST-based, handles wikilinks |
| Frontmatter | `gray-matter` | YAML/TOML frontmatter |
| Wikilink extraction | `remark-wiki-link` | `[[note-name]]` → edges |
| Embeddings | `@huggingface/transformers` | WASM, no Python, no API key |
| Embedding model | `nomic-embed-text` or `all-MiniLM-L6-v2` | ~80MB, runs locally |
| Vector index | `hnswlib-node` | HNSW, fast ANN search, file-backed |
| Knowledge graph | `graphology` | Directed graph, serializable to JSON |
| Graph algorithms | `graphology-traversal` | BFS/DFS, shortest path |
| File watching | `chokidar` | Incremental reindex on change |
| MCP server | `@modelcontextprotocol/sdk` | stdio transport |
| CLI | `commander` | `semantic-pages --vault ./vault` |

---

## Phase 1 — Project Scaffold

**Goal:** Repo structure, TypeScript config, build pipeline.

```
semantic-pages/
├── src/
│   ├── core/                    # Pure library — no transport assumptions
│   │   ├── index.ts             # Core exports
│   │   ├── indexer.ts           # Markdown parser + indexer
│   │   ├── embedder.ts          # Embedding model wrapper
│   │   ├── graph.ts             # Knowledge graph builder
│   │   ├── vector.ts            # HNSW vector index wrapper
│   │   ├── search-text.ts       # Full-text / regex search
│   │   ├── crud.ts              # Create/update/delete/move notes
│   │   ├── frontmatter.ts       # Frontmatter & tag management
│   │   └── watcher.ts           # File watcher + incremental reindex
│   ├── mcp/                     # MCP stdio server (thin wrapper over core)
│   │   ├── server.ts            # Server setup + tool registration
│   │   └── tools/               # Tool definitions (input schemas + handlers)
│   │       ├── search.ts        # search_semantic, search_text, search_graph, search_hybrid
│   │       ├── read.ts          # read_note, read_multiple_notes, list_notes
│   │       ├── write.ts         # create_note, update_note, delete_note, move_note
│   │       ├── metadata.ts      # get_frontmatter, update_frontmatter, manage_tags, rename_tag
│   │       ├── graph.ts         # backlinks, forwardlinks, graph_path, graph_statistics
│   │       └── system.ts        # get_stats, reindex
│   └── cli/                     # CLI entrypoint
│       └── index.ts
├── test/
│   ├── fixtures/
│   │   └── vault/           # Test vault (~20 .md files with known structure)
│   ├── unit/                # Core library unit tests
│   ├── integration/         # MCP server end-to-end tests
│   └── setup.ts             # Test helpers, temp dir management
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── LICENSE
└── README.md
```

Tasks:
- [ ] `npm init`, install deps
- [ ] `tsconfig.json` (ESM, strict)
- [ ] Build script (`tsc` or `tsup`)
- [ ] Basic CLI stub with `commander`

---

## Phase 2 — Markdown Indexer

**Goal:** Parse all `.md` files in vault → structured documents.

Each document produces:
```ts
{
  path: string,          // relative path in vault
  title: string,         // from frontmatter or filename
  content: string,       // raw text (stripped of markdown syntax)
  frontmatter: object,   // YAML metadata
  wikilinks: string[],   // [[linked-notes]]
  tags: string[],        // #tags
  headers: string[],     // H1, H2, H3 headings
  chunks: string[],      // text split into ~512 token chunks for embedding
}
```

Tasks:
- [ ] Walk `<notes-path>/**/*.md` with `glob` (any directory passed via `--notes`)
- [ ] Parse frontmatter with `gray-matter`
- [ ] Parse markdown AST with `unified` + `remark-parse`
- [ ] Extract wikilinks with `remark-wiki-link`
- [ ] Strip markdown → plain text for embedding
- [ ] Chunk text at ~512 tokens with sentence boundaries

---

## Phase 3 — Embedding Engine

**Goal:** Generate dense vector embeddings for each chunk using a local WASM model.

- Model: `nomic-embed-text-v1.5` (first choice) or `all-MiniLM-L6-v2` (fallback)
- Downloaded once, cached in `~/.semantic-pages/models/`
- Runs entirely in Node.js via `@huggingface/transformers` WASM backend
- No API key, no internet required after first run

Tasks:
- [ ] Model download + cache on first run
- [ ] Batch embedding (all chunks for a document)
- [ ] Normalize vectors (cosine similarity prep)
- [ ] Serialize embeddings to `.semantic-pages-index/embeddings.bin`

---

## Phase 4 — Knowledge Graph

**Goal:** Build a directed graph of note relationships.

Edges come from:
1. **Wikilinks** — `[[note-name]]` in content → explicit link
2. **Tags** — shared tags → implicit similarity
3. **Backlinks** — reverse of wikilinks

Graph stored as:
- Nodes: note paths + metadata
- Edges: relationship type + weight
- Serialized to `.semantic-pages-index/graph.json`

Tasks:
- [ ] Build graph from wikilinks across all documents
- [ ] Add tag-based edges (notes sharing tags)
- [ ] Compute backlinks and forwardlinks
- [ ] Serialize/deserialize graph with `graphology-serialization`
- [ ] `search_graph(concept)` → BFS from matching node → return connected notes
- [ ] `backlinks(note)` → all notes linking TO a given note
- [ ] `forwardlinks(note)` → all notes linked FROM a given note
- [ ] `graph_path(from, to)` → shortest path between two notes
- [ ] `graph_statistics()` → most connected nodes, orphans, clusters, density
- [ ] Tag-based traversal — find notes sharing tags with a source note

---

## Phase 5 — Vector & Text Search

**Goal:** HNSW index for semantic search + full-text index for exact matching.

- Semantic: HNSW index built from all chunk embeddings, stored at `.semantic-pages-index/hnsw.bin`
- Text: keyword/regex search across all indexed documents with filters

Tasks:
- [ ] Build HNSW index with `hnswlib-node`
- [ ] Save/load index from disk
- [ ] `search_semantic(query, k)` → embed query → ANN search → return top-k docs
- [ ] `search_text(query, options)` → keyword/regex search across all notes
- [ ] Support search filters: path glob, tag filter, date range, frontmatter field match
- [ ] `read_multiple_notes(paths)` → batch read for reduced round-trips

---

## Phase 6 — CRUD Operations

**Goal:** Full read/write/move/delete operations over notes, so Claude can maintain the knowledge base — not just search it.

Tasks:
- [ ] `create_note(path, content, frontmatter?)` — create a new markdown file
- [ ] `update_note(path, content, mode)` — modes: overwrite, append, prepend, patch-by-heading
- [ ] `delete_note(path)` — remove a file (with confirmation flag)
- [ ] `move_note(from, to)` — move/rename a note, update wikilinks that reference it
- [ ] On any write operation: trigger incremental reindex of affected notes + graph edges

---

## Phase 7 — Frontmatter & Tag Management

**Goal:** Structured operations on YAML frontmatter and tags — treat metadata as first-class, not just raw text.

Tasks:
- [ ] `get_frontmatter(path)` — return parsed YAML frontmatter as JSON
- [ ] `update_frontmatter(path, fields)` — set/delete individual frontmatter keys atomically
- [ ] `manage_tags(path, action, tags)` — actions: add, remove, list; handles both frontmatter tags and inline `#tags`
- [ ] `rename_tag(old, new)` — vault-wide tag rename across all notes

---

## Phase 8 — MCP Server

**Goal:** Expose all tools to Claude via stdio MCP protocol.

**Tools exposed:**

| Tool | Description |
|---|---|
| **Search** | |
| `search_semantic` | Vector similarity search — "find notes similar to this idea" |
| `search_text` | Full-text keyword/regex search with path, tag, and date filters |
| `search_graph` | Graph traversal — "find notes connected to this concept" |
| `search_hybrid` | Combined — semantic results re-ranked by graph proximity |
| **Read** | |
| `read_note` | Read full content of a specific note |
| `read_multiple_notes` | Batch read multiple notes in one call |
| `list_notes` | List all indexed notes with metadata |
| **Write** | |
| `create_note` | Create a new markdown note |
| `update_note` | Edit note content (overwrite, append, prepend, patch-by-heading) |
| `delete_note` | Delete a note |
| `move_note` | Move/rename a note, update referencing wikilinks |
| **Metadata** | |
| `get_frontmatter` | Read parsed YAML frontmatter |
| `update_frontmatter` | Set/delete frontmatter keys atomically |
| `manage_tags` | Add, remove, or list tags on a note |
| `rename_tag` | Vault-wide tag rename across all notes |
| **Graph** | |
| `backlinks` | All notes linking TO a given note |
| `forwardlinks` | All notes linked FROM a given note |
| `graph_path` | Shortest path between two notes |
| `graph_statistics` | Most connected nodes, orphans, clusters, density |
| **System** | |
| `get_stats` | Vault stats — total notes, chunks, index freshness, graph density |
| `reindex` | Force full reindex of vault |

Tasks:
- [ ] Set up `@modelcontextprotocol/sdk` stdio server
- [ ] Implement each tool with proper input schemas
- [ ] Error handling (vault not found, model not loaded, etc.)

---

## Phase 9 — File Watcher

**Goal:** Incremental reindex when vault files change. No manual reindex needed.

- Watch `<notes-path>/**/*.md` with `chokidar`
- On add/change: re-parse → re-embed → update HNSW + graph
- On delete: remove from index

Tasks:
- [ ] `chokidar` watcher in background
- [ ] Incremental HNSW update (add/remove vectors)
- [ ] Incremental graph update (add/remove nodes + edges)
- [ ] Debounce rapid changes (e.g. editor auto-save)

---

## Phase 10 — Testing & QA

**Goal:** Comprehensive test coverage before publishing. Every tool, every edge case, every failure mode.

### Test infrastructure

- Framework: `vitest` (fast, TypeScript-native, ESM-first)
- Test vault: `test/fixtures/vault/` — a small vault of ~20 markdown files with known wikilinks, tags, frontmatter, edge cases
- Temp directories for CRUD tests (create, modify, delete without polluting fixtures)

### Unit tests (core library)

- [ ] **Indexer** — parse frontmatter, extract wikilinks, extract tags, extract headers, chunk text at sentence boundaries
- [ ] **Indexer edge cases** — empty files, no frontmatter, broken YAML, binary files in vault, deeply nested dirs, unicode filenames
- [ ] **Embedder** — model loads, generates vectors of correct dimension, batch embedding, normalize vectors
- [ ] **Graph** — build from wikilinks, backlinks computed, tag edges, serialize/deserialize round-trip
- [ ] **Graph queries** — `backlinks()`, `forwardlinks()`, `graph_path()` returns shortest path, `graph_statistics()` returns correct counts
- [ ] **Vector search** — index build, save/load, top-k returns correct order, empty index handling
- [ ] **Text search** — keyword match, regex, path filter, tag filter, case sensitivity, no results case
- [ ] **CRUD** — create writes correct file + frontmatter, update modes (overwrite/append/prepend/patch-by-heading), delete removes file + updates graph, move updates wikilinks across vault
- [ ] **Frontmatter** — get returns parsed YAML, update sets/deletes keys atomically, doesn't corrupt non-YAML content
- [ ] **Tags** — add inline/frontmatter tags, remove tags, rename vault-wide, handles tags inside code blocks (should skip them)

### Integration tests (MCP server)

- [ ] **Server lifecycle** — starts, responds to `initialize`, lists all 22 tools, shuts down cleanly
- [ ] **Each tool end-to-end** — call via MCP protocol → verify response shape and content against test vault
- [ ] **Error handling** — invalid note path returns error (not crash), missing vault dir, query on empty index, malformed inputs
- [ ] **Write → Search round-trip** — `create_note` → `search_semantic` finds it → `update_note` → search reflects change → `delete_note` → search no longer returns it
- [ ] **Concurrent operations** — read during reindex, write during search

### File watcher tests

- [ ] **Add** — create file in vault → index updates within debounce window
- [ ] **Change** — modify file → embeddings + graph update
- [ ] **Delete** — remove file → removed from index + graph
- [ ] **Rapid changes** — 10 saves in 1 second → single reindex (debounce works)
- [ ] **Non-markdown** — `.txt`, `.png` added to vault → ignored

### Performance / stress tests

- [ ] **Large vault** — 1,000 markdown files, index builds in reasonable time
- [ ] **Large file** — single 50,000-word note, chunking doesn't OOM
- [ ] **Search latency** — semantic search returns in <500ms on 1k-note index
- [ ] **Index size** — `.semantic-pages-index/` stays reasonable (~100MB for 1k notes)

### CLI tests

- [ ] `--notes ./vault` starts MCP server on stdio
- [ ] `--reindex` triggers full reindex and exits
- [ ] `--stats` prints vault statistics and exits
- [ ] `--notes` with nonexistent path → clear error message
- [ ] `npx semantic-pages --notes .` works without prior install (clean npm cache test)

### Pre-publish checklist

- [ ] All tests pass on Node 18, 20, and 22
- [ ] No warnings from `npm pack --dry-run`
- [ ] Package size is reasonable (<5MB excluding model downloads)
- [ ] `npx semantic-pages --notes ./test/fixtures/vault --stats` works from a clean install

---

## Phase 11 — CLI + npm Package

**Goal:** `npx semantic-pages --notes <path>` works out of the box against any directory.
Publish as a polished npm package that's discoverable and easy to install.

### Architecture

Core library with a thin CLI/MCP transport layer:

```
src/
├── core/              ← pure library, no transport assumptions
│   ├── indexer.ts
│   ├── embedder.ts
│   ├── graph.ts
│   ├── vector.ts
│   ├── crud.ts
│   └── frontmatter.ts
├── mcp/               ← MCP stdio server
│   └── server.ts
└── cli/               ← CLI entrypoint
    └── index.ts
```

This separation means the core can be imported as a library (`import { index, search } from 'semantic-pages'`)
while the CLI/MCP server is just a thin wrapper.

### Usage

```bash
# Run as MCP server (stdio) — point at any folder of .md files
semantic-pages --notes ./vault
semantic-pages --notes ./docs
semantic-pages --notes ./notes
semantic-pages --notes .          # whole repo

# Force reindex
semantic-pages --notes ./vault --reindex

# Show index stats
semantic-pages --notes ./vault --stats
```

### MCP config

`.mcp.json` entry — each repo uses its own path:
```json
{
  "semantic-pages": {
    "command": "npx",
    "args": ["-y", "semantic-pages", "--notes", "./vault"]
  }
}
```

### package.json essentials

```json
{
  "name": "semantic-pages",
  "description": "Semantic search + knowledge graph MCP server for any folder of markdown files",
  "keywords": [
    "mcp", "model-context-protocol", "semantic-search", "knowledge-graph",
    "markdown", "obsidian", "vector-search", "embeddings", "wikilinks",
    "claude", "llm", "ai", "notes", "vault"
  ],
  "bin": {
    "semantic-pages": "./dist/cli/index.js"
  },
  "main": "./dist/core/index.js",
  "types": "./dist/core/index.d.ts",
  "exports": {
    ".": "./dist/core/index.js",
    "./mcp": "./dist/mcp/server.js"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "license": "MIT",
  "engines": { "node": ">=18" },
  "repository": { "type": "git", "url": "..." }
}
```

### Tasks

- [ ] CLI with `commander` (`--notes`, `--reindex`, `--stats`, `--model`, `--watch`)
- [ ] `package.json` with bin, main, types, exports, keywords, engines
- [ ] Separate core exports from MCP transport (importable as library)
- [ ] `README.md` — install, `.mcp.json` snippet, tool reference, examples
- [ ] `LICENSE` (MIT)
- [ ] `.npmignore` or `files` field to keep package lean
- [ ] Verify `npx semantic-pages --notes .` works without prior install
- [ ] Publish to npm as `semantic-pages`

---

## Phase 12 — Glitch Kingdom Marketplace Publishing

**Goal:** Register semantic-pages in the [glitch-kingdom-of-plugins](https://github.com/TheGlitchKing/glitch-kingdom-of-plugins) marketplace as an `mcp-server` type plugin.

### Marketplace entry for `marketplace.json`

```json
{
  "id": "semantic-pages",
  "name": "semantic-pages",
  "displayName": "Semantic Pages",
  "type": "mcp-server",
  "version": "1.0.0",
  "description": "Semantic search + knowledge graph MCP server for any folder of markdown files. Full CRUD, frontmatter management, graph traversal, and hybrid search — no Obsidian, Docker, or Python required.",
  "author": {
    "name": "TheGlitchKing"
  },
  "repository": {
    "type": "github",
    "owner": "TheGlitchKing",
    "repo": "semantic-pages",
    "url": "https://github.com/TheGlitchKing/semantic-pages"
  },
  "source": {
    "type": "submodule",
    "path": "plugins/semantic-pages"
  },
  "installation": {
    "methods": [
      {
        "type": "npm",
        "command": "npm install -g semantic-pages"
      },
      {
        "type": "npx",
        "command": "npx semantic-pages --notes ./vault"
      },
      {
        "type": "claude-marketplace",
        "command": "/plugin install TheGlitchKing/semantic-pages"
      }
    ],
    "requirements": {
      "node": ">=18.0.0"
    }
  },
  "category": "search",
  "tags": ["mcp-server", "semantic-search", "knowledge-graph", "markdown", "vector-search", "claude-plugin"],
  "keywords": [
    "mcp", "model-context-protocol", "semantic-search", "knowledge-graph",
    "markdown", "obsidian", "vector-search", "embeddings", "wikilinks",
    "claude", "llm", "notes", "vault", "frontmatter", "backlinks"
  ],
  "license": "MIT",
  "homepage": "https://github.com/TheGlitchKing/semantic-pages",
  "status": "beta",
  "features": {
    "mcpServers": ["semantic-pages"],
    "commands": []
  }
}
```

### Tasks

- [ ] Create GitHub repo `TheGlitchKing/semantic-pages`
- [ ] Add as git submodule under `plugins/semantic-pages` in glitch-kingdom-of-plugins
- [ ] Add plugin entry to `marketplace.json` (schema: `./schemas/plugin-schema.json`)
- [ ] Ensure `"search"` category exists in marketplace categories (or add it)
- [ ] Verify marketplace schema validation passes
- [ ] Update status from `"beta"` → `"production-ready"` once Phase 10 is complete

---

## Index Layout

```
.semantic-pages-index/     ← gitignored, rebuilt on demand
├── embeddings.bin         ← serialized chunk vectors
├── hnsw.bin               ← HNSW index
├── graph.json             ← knowledge graph
└── meta.json              ← index metadata (vault path, model, last indexed)
```

---

## Open Questions

- [ ] Which embedding model to default to? (`nomic-embed-text` vs `all-MiniLM-L6-v2`)
- [ ] Chunk size? (512 tokens seems right, may need tuning)
- [ ] Should `search_hybrid` weight vector vs graph results? (start 70/30)
- [ ] Support multiple note directories in one server instance?
- [ ] Auto-start watcher or manual `--watch` flag?
- [ ] `--notes` defaults to `./notes` if present, then `./vault`, then `.` (whole repo)?

---

## Estimated Scope

| Phase | Lines of TS | Complexity |
|---|---|---|
| 1 — Scaffold | 50 | Low |
| 2 — Indexer | 200 | Medium |
| 3 — Embedder | 150 | Medium |
| 4 — Graph | 300 | Medium |
| 5 — Vector & text search | 250 | Medium |
| 6 — CRUD operations | 200 | Medium |
| 7 — Frontmatter & tags | 150 | Medium |
| 8 — MCP server | 300 | Medium |
| 9 — File watcher | 100 | Low |
| 10 — Testing & QA | 400 | Medium |
| 11 — CLI + npm package | 100 | Low |
| 12 — Marketplace publishing | 20 | Low |
| **Total** | **~2,220** | |
