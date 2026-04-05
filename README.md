# semantic-pages

Semantic search + knowledge graph MCP server for any folder of markdown files.

No Docker. No Python. No Obsidian. Just `npx`.

## Install

```bash
npx semantic-pages --notes ./vault
```

Or install globally:

```bash
npm install -g semantic-pages
semantic-pages --notes ./vault
```

## MCP Configuration

Add to your `.mcp.json` (Claude Code, Cursor, etc.):

```json
{
  "semantic-pages": {
    "command": "npx",
    "args": ["-y", "semantic-pages", "--notes", "./vault"]
  }
}
```

Point `--notes` at any folder of `.md` files: `./vault`, `./docs`, `./notes`, or `.` for the whole repo.

## What It Does

semantic-pages gives your AI assistant native tool access to your markdown notes via the Model Context Protocol. It replaces the Obsidian + Smart Connections + MCP plugin stack with a single npm package.

### 21 MCP Tools

**Search**

| Tool | Description |
|------|-------------|
| `search_semantic` | Vector similarity search by meaning |
| `search_text` | Full-text keyword/regex search with filters |
| `search_graph` | Graph traversal via wikilinks and tags |
| `search_hybrid` | Combined semantic + graph, re-ranked |

**Read**

| Tool | Description |
|------|-------------|
| `read_note` | Read full content of a note |
| `read_multiple_notes` | Batch read multiple notes |
| `list_notes` | List all notes with metadata |

**Write**

| Tool | Description |
|------|-------------|
| `create_note` | Create a new markdown note |
| `update_note` | Edit (overwrite, append, prepend, patch by heading) |
| `delete_note` | Delete a note (requires confirmation) |
| `move_note` | Move/rename, updates wikilinks across vault |

**Metadata**

| Tool | Description |
|------|-------------|
| `get_frontmatter` | Read YAML frontmatter as JSON |
| `update_frontmatter` | Set/delete frontmatter keys |
| `manage_tags` | Add, remove, or list tags |
| `rename_tag` | Vault-wide tag rename |

**Graph**

| Tool | Description |
|------|-------------|
| `backlinks` | Notes linking TO a given note |
| `forwardlinks` | Notes linked FROM a given note |
| `graph_path` | Shortest path between two notes |
| `graph_statistics` | Most connected nodes, orphans, density |

**System**

| Tool | Description |
|------|-------------|
| `get_stats` | Vault stats (notes, chunks, embeddings, graph) |
| `reindex` | Force full reindex |

## How It Works

1. **Indexes** all `.md` files: parses frontmatter, extracts `[[wikilinks]]`, `#tags`, headers
2. **Embeds** text chunks using a local model ([nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5)) via WASM — no API key needed
3. **Builds** a knowledge graph from wikilinks and shared tags using [graphology](https://graphology.github.io/)
4. **Creates** an HNSW vector index for fast approximate nearest neighbor search
5. **Watches** for file changes and re-indexes incrementally
6. **Serves** all of this over MCP stdio protocol

The index is stored in `.semantic-pages-index/` alongside your notes (gitignore it). The model is downloaded once to `~/.semantic-pages/models/`.

## CLI

```bash
# Start MCP server (default)
semantic-pages --notes ./vault

# Show vault statistics
semantic-pages --notes ./vault --stats

# Force reindex and exit
semantic-pages --notes ./vault --reindex

# Disable file watcher
semantic-pages --notes ./vault --no-watch
```

## As a Library

```typescript
import { Indexer, Embedder, GraphBuilder, VectorIndex } from "semantic-pages";

const indexer = new Indexer("./vault");
const docs = await indexer.indexAll();

const embedder = new Embedder();
await embedder.init();
const vec = await embedder.embed("search query");
```

## Per-Repo Pattern

```
any-repo/
├── notes/                      # your markdown files
├── .mcp.json                   # point semantic-pages at ./notes
├── .semantic-pages-index/      # gitignored, auto-rebuilt
└── .gitignore                  # add .semantic-pages-index/
```

Each repo gets its own independent knowledge base. No shared state between projects.

## Requirements

- Node.js >= 18

## License

MIT
