# Semantic Pages

> Semantic search + knowledge graph MCP server for any folder of markdown files.

[![npm version](https://img.shields.io/npm/v/@theglitchking/semantic-pages.svg)](https://www.npmjs.com/package/@theglitchking/semantic-pages)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> [!IMPORTANT]
> Semantic Pages runs a local embedding model (~22MB) on first launch. This download happens once and is cached at `~/.semantic-pages/models/`. No API key required. No data leaves your machine.

---

## Summary

When you have markdown notes scattered across a project — a `vault/`, `docs/`, `notes/`, or wiki — your AI assistant can't search them by meaning, traverse their connections, or help you maintain them. Semantic Pages fixes this by indexing your markdown files into a vector database and knowledge graph, then exposing 21 MCP tools that let Claude (or any MCP-compatible client) search semantically, traverse wikilinks, manage frontmatter, and perform full CRUD operations. No Docker, no Python, no Obsidian required — just `npx`.

---

## Operational Summary

The server indexes all `.md` files in a directory you point it at. Each file is parsed for YAML frontmatter, `[[wikilinks]]`, `#tags`, and headings. The text content is split into chunks and embedded locally using `all-MiniLM-L6-v2` — a 22MB model that runs natively in Node.js via ONNX. These embeddings are stored in an HNSW index for fast approximate nearest neighbor search. Simultaneously, a directed graph is built from wikilinks and shared tags using graphology.

When Claude calls `search_semantic`, the query is embedded and compared against all chunks via cosine similarity. When Claude calls `search_graph`, it does a breadth-first traversal from matching nodes. `search_hybrid` combines both — semantic results re-ranked by graph proximity. Beyond search, Claude can create, read, update, delete, and move notes, manage YAML frontmatter fields, add/remove/rename tags vault-wide, and query the knowledge graph for backlinks, forwardlinks, shortest paths, and connectivity statistics.

The index is stored in `.semantic-pages-index/` alongside your notes (gitignore it). A file watcher detects changes and re-indexes incrementally. Everything runs locally over stdio — no network, no server, no background processes beyond the MCP connection itself.

---

## Features

- **Semantic Search**: Find notes by meaning, not just keywords, using local vector embeddings
- **Knowledge Graph**: Traverse `[[wikilinks]]` and shared `#tags` as a directed graph
- **Hybrid Search**: Combined vector + graph search with re-ranking
- **Full-Text Search**: Keyword and regex search with path, tag, and case filters
- **Full CRUD**: Create, read, update (overwrite/append/prepend/patch-by-heading), delete, and move notes
- **Frontmatter Management**: Get and set YAML frontmatter fields atomically
- **Tag Management**: Add, remove, list, and rename tags vault-wide (frontmatter + inline)
- **Graph Queries**: Backlinks, forwardlinks, shortest path, graph statistics (orphans, density, most connected)
- **File Watcher**: Incremental re-indexing on file changes with debounce
- **Local Embeddings**: No API key, no network after first model download
- **Zero Dependencies Beyond Node**: No Docker, no Python, no Obsidian, no GUI
- **Auto-Wire**: Installing the Claude Code plugin auto-creates `./.claude/.vault/` and wires it as a read/write MCP server — no manual `.mcp.json` editing required
- **Sister Plugin Companion**: When [`hit-em-with-the-docs`](https://github.com/TheGlitchKing/hit-em-with-the-docs) is also installed, a second **read-only** MCP server is auto-wired at `./.documentation/` so you can semantically search your docs without risking accidental writes to a tree that hewtd owns

---

## Sister Plugin: hit-em-with-the-docs

[`hit-em-with-the-docs`](https://github.com/TheGlitchKing/hit-em-with-the-docs) is the **canonical writer** of `./.documentation/`. It scaffolds, classifies, maintains, and validates docs across 15 domains with a 22-field metadata schema. Semantic Pages is the **canonical reader** — when both plugins are installed, Semantic Pages auto-wires a read-only index of `./.documentation/` so Claude can search it, traverse its wikilinks, and list/read docs without any write primitives exposed. That split keeps hewtd the sole authority for writes while giving you semantic discovery over the result.

### The matrix

| `semantic-pages` installed | `hit-em-with-the-docs` installed | Result |
|---|---|---|
| ✗ | ✗ | nothing |
| ✗ | ✓ | hewtd CLI only; `.documentation/` managed but not indexed |
| ✓ | ✗ | single MCP at `./.claude/.vault` (read/write, auto-created) |
| ✓ | ✓ | `./.claude/.vault` (read/write) **+** `./.documentation` (read-only) |

### How the auto-wire works

Semantic Pages ships a `SessionStart` hook that runs at the start of every Claude Code session and reconciles the project's `.mcp.json`:

1. Always ensures `./.claude/.vault/` exists (creates if missing)
2. Always ensures a `semantic-vault` MCP entry pointed at `./.claude/.vault` (read/write — your personal research notes, session artifacts, scratch graph)
3. If `hit-em-with-the-docs` is in your enabled plugins **and** `./.documentation/` exists in the current project → adds a `semantic-pages` MCP entry pointed at `./.documentation` with `--read-only` (the 7 write tools are suppressed at the MCP tool list level)
4. If either condition stops being true → idempotently removes the `semantic-pages` entry (self-healing when you uninstall hewtd or the docs tree goes away)

The hook is a no-op when the computed `.mcp.json` matches what's already on disk, so there's no git churn from repeated session starts. It only touches its own entries — any custom MCP servers you've added (playwright, custom tools, etc.) are left untouched. If you've manually defined a `semantic-pages` entry pointing at a non-`.documentation` path, the hook respects it and leaves it alone.

### Why read-only for `.documentation/`

`./.documentation/` is a **managed tree** — hewtd owns the lifecycle (creates files, classifies them, maintains frontmatter, prunes stale entries, checks links). If Semantic Pages also exposed `create_note`, `update_note`, `delete_note`, `move_note`, `update_frontmatter`, `manage_tags`, and `rename_tag` over that tree, you'd have two writers racing over the same schema and hewtd couldn't guarantee its invariants. Read-only gives you semantic discovery without that risk. Your personal `.claude/.vault/` stays fully read/write — hewtd doesn't touch it, so Semantic Pages is the sole writer there and all 21 tools are available.

### The `--read-only` flag

The auto-wire uses a new `--read-only` CLI flag (v0.6.0+) that filters out the 7 write tools from the MCP server's tool list at startup. You can use it manually anywhere:

```bash
semantic-pages --notes ./any-shared-vault --read-only
```

Only the 14 read tools are exposed (`search_*`, `read_note`, `read_multiple_notes`, `list_notes`, `backlinks`, `forwardlinks`, `graph_path`, `graph_statistics`, `get_frontmatter`, `get_stats`, `reindex`).

---

## Quick Start

### 1. Installation Methods

#### Method A: Claude Code Plugin (Recommended — zero config, auto-wires)

The easiest path if you use Claude Code. Install once per project; the plugin handles `.mcp.json` wiring automatically.

```bash
# Inside a Claude Code session:
/plugin marketplace add TheGlitchKing/semantic-pages
/plugin install semantic-pages@semantic-pages-marketplace
```

What happens next session:
1. A `SessionStart` hook runs and ensures `./.claude/.vault/` exists
2. Your project's `.mcp.json` gets a `semantic-vault` entry pointed at `./.claude/.vault` (read/write)
3. **If** `hit-em-with-the-docs` is also installed **and** `./.documentation/` exists → a second `semantic-pages` entry is added, pointed at `./.documentation` with `--read-only`
4. You get 21 tools (14 if the docs server is the one being used) for semantic search, graph traversal, and (for the vault) note CRUD

No manual `.mcp.json` editing. Uninstalling the plugin cleanly leaves your existing entries alone on the next session.

#### Method B: Project Installation (Recommended for teams and AI-assisted projects)

Install per-project so the version is pinned in `package.json`, stays in sync across teammates and CI, and is visible to any LLM reading the repo.

```bash
npm install --save-dev @theglitchking/semantic-pages
```

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "semantic-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no", "@theglitchking/semantic-pages", "--notes", "./.claude/.vault"]
    }
  }
}
```

> **Why project-level over global?** A global install is invisible to collaborators, CI, and LLMs reading the repo. A project-level install pins the exact version in `package.json`, so every agent and developer working in the repo sees the same binary. Use `npx --no` (not `npx -y`) so npx uses the locally-installed version instead of fetching from the registry.

#### Method C: MCP Configuration via NPX (Quick setup, no install)

Add directly to your project's `.mcp.json`. npx downloads and caches the package on first use.

```json
{
  "mcpServers": {
    "semantic-vault": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@theglitchking/semantic-pages", "--notes", "./.claude/.vault"]
    }
  }
}
```

Point `--notes` at any folder of `.md` files: `./vault`, `./docs`, `./notes`, or `.` for the whole repo.

**What to expect**: Next time you run `claude` in that project, Claude will have 21 new tools for searching, reading, writing, and traversing your notes.

> **Note on `@latest` and npx caching**: If you use `@latest` in the args, npx may serve a stale cached version after a new release. To force a refresh: `rm -rf ~/.npm/_npx/*/node_modules/@theglitchking`. Project-level installation (Method B) avoids this entirely.

#### Method D: Try it with NPX (No installation needed)

```bash
npx @theglitchking/semantic-pages --notes ./vault --stats
```

The first run downloads the package and the embedding model (~80 MB) and takes 1–2 minutes. After that it runs instantly from cache. Use this to evaluate before committing to a project install.

#### Method E: Global Installation (Not recommended)

```bash
npm install -g @theglitchking/semantic-pages
```

Avoid this for projects — a global install is invisible to collaborators, CI, and LLMs reading the repo, and will silently fall out of sync with the version everyone else is using. Use project-level installation (Method B) instead.

---

### 2. How to Use

#### CLI Commands

These commands run in your terminal and manage your notes index.

| Command | Description |
|---------|-------------|
| `semantic-pages --notes <path>` | Start MCP server (default mode) |
| `semantic-pages --notes <path> --stats` | Show vault statistics and exit |
| `semantic-pages --notes <path> --reindex` | Force full reindex and exit |
| `semantic-pages --notes <path> --wait-for-ready` | Block startup until indexing finishes (default: index in background) |
| `semantic-pages --notes <path> --no-watch` | Start server without file watcher |
| `semantic-pages tools` | List all 21 MCP tools with descriptions |
| `semantic-pages tools <name>` | Show arguments and examples for a specific tool |
| `semantic-pages --version` | Show version number |
| `semantic-pages --help` | Show all options |

##### Built-in Tool Help

Every MCP tool has built-in documentation accessible from the CLI:

```bash
# List all 21 tools organized by category
semantic-pages tools
```

```
Semantic Pages — 21 MCP Tools

  Search:
    search_semantic          Vector similarity search — find notes by meaning, not just keywords
    search_text              Full-text keyword or regex search with optional filters
    search_graph             Graph traversal — find notes connected to a concept via wikilinks and tags
    search_hybrid            Combined semantic + graph search — vector results re-ranked by graph proximity

  Read:
    read_note                Read the full content of a specific note by path
    read_multiple_notes      Batch read multiple notes in one call
    list_notes               List all indexed notes with metadata (title, tags, link count)
    ...
```

```bash
# Get detailed help for a specific tool — arguments, types, and examples
semantic-pages tools search_semantic
```

```
  search_semantic
  ───────────────
  Vector similarity search — find notes by meaning, not just keywords

  Arguments:
    { "query": "string", "limit?": 10 }

  Examples:
    { "query": "microservices architecture", "limit": 5 }
    { "query": "how to deploy to production" }
```

```bash
# More examples
semantic-pages tools update_note      # See all 4 editing modes
semantic-pages tools move_note        # See wikilink-aware rename
semantic-pages tools manage_tags      # See add/remove/list actions
semantic-pages tools rename_tag       # See vault-wide tag rename
```

##### Command Examples and Details

**`--stats` - Check your vault**

**How to use it**:
```bash
semantic-pages --notes ./vault --stats
```

**When to use it**: Quick check to see what's in your vault.

**What to expect**:
```
Notes: 47
Chunks: 312
Wikilinks: 89
Tags: 23 unique
```

---

**`--reindex` - Rebuild the index**

**How to use it**:
```bash
semantic-pages --notes ./vault --reindex
```

**When to use it**:
- After bulk-adding or modifying notes outside of the MCP tools
- If the index seems stale or corrupted
- After changing the embedding model

**What to expect**: Full re-parse, re-embed, and re-index of all markdown files. Takes 30 seconds to ~20 minutes depending on vault size and hardware. See [Performance Tuning](./.documentation/performance-tuning.md) for details.

---

**`--wait-for-ready` - Block startup until the index is fully built** *(0.6.2+)*

**How to use it**:
```bash
semantic-pages --notes ./vault --wait-for-ready
```

**When to use it**:
- Scripted setups where you need to know the server is actually ready before sending tool calls
- CI / test harnesses that should not race against background indexing
- Anywhere you'd otherwise have to poll `get_stats` until `indexState === "ready"`

**What to expect**: The default behavior is to start the server immediately and build the index in the background — search/list tools return `"Indexing in progress..."` until ready. With `--wait-for-ready`, startup blocks until the model is loaded and the index is fully built; the first tool call you make is guaranteed to hit live data. Trade-off: longer startup, no polling needed.

---

#### MCP Tools

When the server is running (via `.mcp.json` or CLI), Claude has access to these 21 tools:

##### Search Tools

| Tool | Description |
|------|-------------|
| `search_semantic` | Vector similarity search — "find notes similar to this idea" |
| `search_text` | Full-text keyword/regex search with path, tag, and case filters |
| `search_graph` | Graph traversal — "find notes connected to this concept" |
| `search_hybrid` | Combined — semantic results re-ranked by graph proximity |

**`search_semantic` - Find notes by meaning**

**When Claude uses it**: When you ask things like "find notes about deployment strategies" or "what have I written about authentication?"

**What to expect**: Returns notes ranked by semantic similarity to your query, with relevance scores and text snippets. Works even if the exact words don't appear in the notes.

**Example conversation**:
```
You: What notes do I have about scaling microservices?
Claude: [calls search_semantic with query "scaling microservices"]
Claude: I found 4 relevant notes:
1. architecture/scaling-patterns.md (0.87 similarity) — discusses horizontal vs vertical scaling
2. devops/kubernetes-autoscaling.md (0.82 similarity) — HPA and VPA configuration
3. architecture/service-mesh.md (0.71 similarity) — mentions scaling in the context of Istio
4. meeting-notes/2024-03-15.md (0.65 similarity) — team discussion about scaling concerns
```

---

**`search_text` - Find exact matches**

**When Claude uses it**: When you need exact keyword or regex matches, not semantic similarity.

**What to expect**: Returns notes containing the exact pattern, with snippets showing context. Supports:
- Case-sensitive/insensitive search
- Regex patterns
- Path glob filters (e.g., only search in `notes/`)
- Tag filters (e.g., only search notes tagged `#architecture`)

---

**`search_graph` - Traverse connections**

**When Claude uses it**: When you want to explore how notes are connected — "what's related to this concept?"

**What to expect**: Starting from notes matching your concept, does a breadth-first traversal through wikilinks and shared tags, returning all connected notes within the specified depth.

---

**`search_hybrid` - Best of both**

**When Claude uses it**: When you want comprehensive results — semantic matches boosted by graph proximity.

**What to expect**: Semantic search results re-ranked so that notes which are also graph-connected score higher. Best for "find everything relevant to X."

---

##### Read Tools

| Tool | Description |
|------|-------------|
| `read_note` | Read full content of a specific note |
| `read_multiple_notes` | Batch read multiple notes in one call |
| `list_notes` | List all indexed notes with metadata (title, tags, link count) |

---

##### Write Tools

| Tool | Description |
|------|-------------|
| `create_note` | Create a new markdown note with optional frontmatter |
| `update_note` | Edit note content (overwrite, append, prepend, or patch by heading) |
| `delete_note` | Delete a note (requires explicit confirmation) |
| `move_note` | Move/rename a note — automatically updates wikilinks across the vault |

**`update_note` - Four editing modes**

**Modes**:
- `overwrite` — replace entire content
- `append` — add to the end
- `prepend` — add after frontmatter, before existing content
- `patch-by-heading` — replace the content under a specific heading (preserves other sections)

**Example**:
```
You: Add a "Rollback" section to the deployment guide
Claude: [calls update_note with mode "patch-by-heading", heading "Rollback"]
Claude: Updated deployment-guide.md — added Rollback section with kubectl rollback instructions.
```

---

**`move_note` - Smart rename**

**What makes it special**: When you move `user-service.md` to `auth-service.md`, every `[[user-service]]` wikilink in every other note gets updated to `[[auth-service]]` automatically.

---

##### Metadata Tools

| Tool | Description |
|------|-------------|
| `get_frontmatter` | Read parsed YAML frontmatter as JSON |
| `update_frontmatter` | Set or delete frontmatter keys atomically (pass `null` to delete) |
| `manage_tags` | Add, remove, or list tags on a note (frontmatter + inline) |
| `rename_tag` | Rename a tag across all notes in the vault |

**`rename_tag` - Vault-wide tag rename**

**When Claude uses it**: When you want to rename `#architecture` to `#arch` everywhere — in frontmatter `tags:` arrays and inline `#tags` across every file.

**What to expect**: Returns the count of files modified.

---

##### Graph Tools

| Tool | Description |
|------|-------------|
| `backlinks` | All notes that link TO a given note via `[[wikilinks]]` |
| `forwardlinks` | All notes linked FROM a given note |
| `graph_path` | Shortest path between two notes in the knowledge graph |
| `graph_statistics` | Most connected nodes, orphan count, graph density |

**`graph_path` - Find connections between notes**

**Example conversation**:
```
You: How are the deployment guide and the user service connected?
Claude: [calls graph_path from "deployment-guide.md" to "user-service.md"]
Claude: Path: deployment-guide.md → microservices.md → user-service.md
The deployment guide links to the microservices overview, which links to the user service.
```

---

**`graph_statistics` - Vault health overview**

**What to expect**:
```json
{
  "totalNodes": 47,
  "totalEdges": 89,
  "orphanCount": 3,
  "mostConnected": [
    { "path": "project-overview.md", "connections": 12 },
    { "path": "microservices.md", "connections": 9 }
  ],
  "density": 0.04
}
```

---

##### System Tools

| Tool | Description |
|------|-------------|
| `get_stats` | Vault stats — total notes, chunks, embeddings, graph density, model info |
| `reindex` | Force full reindex of the vault |

---

## Bundled Skills

Semantic Pages ships with a Claude Code skill that auto-routes documentation lookups and research tasks through the MCP servers this plugin installs.

### `semantic-first` *(0.6.1+)*

A repo-agnostic skill that teaches Claude to reach for `semantic-pages` and `semantic-vault` **before** falling back to `Grep` / `Glob` / inline web research. It defines two flows that compose:

- **Flow A — docs lookup.** Triggers on prose questions about the current repo ("how does this repo handle X?", "what's our deploy process?", "where's the guide for Y?"). Routes to `mcp__semantic-pages__search_hybrid`, reads the top hits via `read_note`, and answers with filename citations. Activates when the companion plugin [`hit-em-with-the-docs`](https://github.com/TheGlitchKing/hit-em-with-the-docs) is also installed (that's the plugin that owns the docs index).
- **Flow B — research notes.** Triggers on evaluative or comparative questions ("what's the best X for Y?", "is there a better alternative to Z?", any "research/investigate/look into"). Searches `.claude/.vault` for prior research, does fresh web research if needed, and writes findings to `.claude/.vault/<slug>.md` with structured frontmatter (16 fields adapted from the hewtd 22-field schema). The vault note is the canonical artifact; the chat answer summarizes it with a filename pointer.

Each flow probes its MCP server independently and degrades gracefully when one isn't available.

**Where it lives in the package**: `skills/semantic-first/` (shipped in the npm tarball as of 0.6.1).
- `SKILL.md` — main skill body
- `references/vault-frontmatter.md` — the 16-field vault note schema with per-field rationale
- `evals/evals.json` — the 4 test prompts the skill was iterated against during development

When you install `semantic-pages` via the Claude Code plugin marketplace or via npm, Claude Code picks up this skill automatically — no extra wiring required.

### How auto-linking works *(0.7.0+)*

When installed as an npm dependency, a `postinstall` script symlinks every directory under the package's `skills/` into your project's `.claude/skills/` (creating that directory if missing). Claude Code only scans `<project>/.claude/skills/` and `~/.claude/skills/` — it does not look inside `node_modules/` — so this link is what makes bundled skills discoverable.

- The link is relative, pointing into `node_modules/@theglitchking/semantic-pages/skills/<name>`, and is refreshed on every install/update.
- If a regular file or directory already exists at the destination (i.e. someone copied a skill manually), the script leaves it alone and prints a warning.
- The script is a no-op when you're developing the plugin itself (`INIT_CWD` equals the package root), so the plugin never self-links into its own repo.
- The linker never hard-fails an install — permission errors and odd filesystems downgrade to a warning.

Add the linked skills to `.gitignore` so they don't get committed in consuming projects:

```
/.claude/skills/semantic-first/
```

**Opt-out**: set `SEMANTIC_PAGES_SKIP_LINK=1` to skip linking during install — useful if you want to manage `.claude/skills/` manually.

```bash
SEMANTIC_PAGES_SKIP_LINK=1 npm install @theglitchking/semantic-pages
```

---

## Update Policy & Session-Start Hook *(0.8.0+)*

When you install `semantic-pages` as an npm dependency, the postinstall step also:

1. Writes `<project>/.claude/semantic-pages.json` with `{ "updatePolicy": "nudge" }` if one doesn't exist.
2. Registers a `SessionStart` hook in `<project>/.claude/settings.json` — but **only** if `settings.json` exists and neither the Claude Code plugin nor an existing semantic-pages hook is already handling it.

### What the hook does

At the start of every Claude Code session, the hook:

- Reconciles `.mcp.json` (the same `semantic-vault` + conditional `.documentation` wiring you'd get from the plugin).
- Checks npm for a newer version of `@theglitchking/semantic-pages` (~3s budget, results cached for 6h, skipped in CI).
- Acts on the result according to your policy.

### Policies

| Policy | Behavior |
|--------|----------|
| `nudge` *(default)* | Print a one-liner when a newer version is available. No changes. |
| `auto`  | Run `npm update @theglitchking/semantic-pages`, re-link skills, print `⬆️ vX → vY`. |
| `off`   | Silent — no update check. |

### Setting the policy

Preferred:

```
/semantic-pages:policy auto
/semantic-pages:policy nudge
/semantic-pages:policy off
```

Or from the terminal:

```bash
npx --no @theglitchking/semantic-pages policy auto
```

Resolution order:

1. `SEMANTIC_PAGES_UPDATE_POLICY` env var (one-shot override).
2. `<project>/.claude/semantic-pages.json` → `updatePolicy`.
3. Default: `nudge`.

### Plugin-command menu

With `semantic-pages` installed (plugin or npm), you get these slash commands:

| Command | Does |
|---------|------|
| `/semantic-pages:update`   | Runs `npm update`, re-links skills, reports before/after. |
| `/semantic-pages:policy [auto\|nudge\|off]` | Get or set the update policy. |
| `/semantic-pages:status`   | Installed version, latest on npm, policy, hook state. |
| `/semantic-pages:relink`   | Re-symlink bundled skills into `.claude/skills/`. |

Each has a CLI equivalent: `npx --no @theglitchking/semantic-pages <subcommand>`.

### Dedup between plugin and npm installs

If you install via **both** the Claude Code plugin and the npm dep, the postinstall detects the plugin in `~/.claude/settings.json` → `enabledPlugins` and skips the settings.json hook registration. One hook fires per session, not two. If you later uninstall the plugin, the next `npm install` re-registers the project-level hook.

### Opt-out

```bash
# Skip settings.json hook registration:
SEMANTIC_PAGES_SKIP_HOOK_REGISTER=1 npm install @theglitchking/semantic-pages

# Skip skill symlinking:
SEMANTIC_PAGES_SKIP_LINK=1 npm install @theglitchking/semantic-pages
```

### Uninstalling cleanly

```bash
# 1. Remove the hook entry from .claude/settings.json (look for any SessionStart
#    entry whose command references "semantic-pages").
# 2. Remove the policy file:
rm .claude/semantic-pages.json

# 3. Remove the package:
npm uninstall @theglitchking/semantic-pages
```

---

## Common Workflows

### Quick Vault Check (10 seconds)
```bash
semantic-pages --notes ./vault --stats
```

### Adding Semantic Pages to a Project (2 minutes)
```bash
# Step 1: Create .mcp.json in your project root
echo '{
  "semantic-pages": {
    "command": "npx",
    "args": ["-y", "semantic-pages", "--notes", "./notes"]
  }
}' > .mcp.json

# Step 2: Add index to .gitignore
echo ".semantic-pages-index/" >> .gitignore

# Step 3: Start Claude — it now has 21 note tools
claude
```

### Asking Claude About Your Notes
```
You: What have I written about authentication?
Claude: [calls search_semantic] I found 3 notes about authentication...

You: What links to the API gateway doc?
Claude: [calls backlinks] 4 notes link to api-gateway.md...

You: Create a new note summarizing today's meeting
Claude: [calls create_note] Created meeting-2024-03-15.md with frontmatter...

You: Rename the #backend tag to #server across all notes
Claude: [calls rename_tag] Renamed #backend to #server in 12 files.
```

### Per-Repo Pattern
```
any-repo/
├── notes/                      # your markdown files
├── .mcp.json                   # point semantic-pages at ./notes
├── .semantic-pages-index/      # gitignored, auto-rebuilt
└── .gitignore                  # add .semantic-pages-index/
```

Each repo gets its own independent knowledge base. No shared state between projects.

---

## Technical Details

### Architecture Overview

Semantic Pages is built with TypeScript and organized into a core library with thin transport layers:

```
src/
├── core/                        # Pure library — no transport assumptions
│   ├── index.ts                # Core exports
│   ├── types.ts                # Shared type definitions
│   ├── indexer.ts              # Markdown parser (unified + remark)
│   ├── embedder.ts             # Local embedding model (@huggingface/transformers)
│   ├── graph.ts                # Knowledge graph (graphology)
│   ├── vector.ts               # HNSW vector index (hnswlib-node)
│   ├── search-text.ts          # Full-text / regex search
│   ├── crud.ts                 # Create/update/delete/move notes
│   ├── frontmatter.ts          # Frontmatter + tag management
│   └── watcher.ts              # File watcher (chokidar)
│
├── mcp/                         # MCP stdio server (thin wrapper over core)
│   └── server.ts               # Server setup + 21 tool definitions
│
└── cli/                         # CLI entrypoint
    └── index.ts                # commander-based CLI
```

### Tech Stack

| Concern | Package | Why |
|---------|---------|-----|
| Markdown parsing | `unified` + `remark-parse` | AST-based, handles wikilinks |
| Frontmatter | `gray-matter` | YAML/TOML frontmatter extraction |
| Wikilinks | `remark-wiki-link` | `[[note-name]]` extraction from AST |
| Embeddings | `@huggingface/transformers` + `onnxruntime-node` | Native ONNX runtime, no Python, no API key |
| Embedding model | `all-MiniLM-L6-v2` (default) | ~22MB, fast (~3 min / 3K chunks), excellent retrieval quality |
| Vector index | `hnswlib-node` | HNSW algorithm, same as production vector DBs |
| Knowledge graph | `graphology` | Directed graph, serializable, rich algorithms |
| Graph algorithms | `graphology-traversal` + `graphology-shortest-path` | BFS, shortest path |
| File watching | `chokidar` | Cross-platform, debounced |
| MCP server | `@modelcontextprotocol/sdk` | Official MCP TypeScript SDK |
| CLI | `commander` | Standard Node.js CLI framework |

### Index Layout

```
.semantic-pages-index/           # gitignored, rebuilt on demand
├── embeddings.json              # serialized chunk vectors
├── hnsw.bin                     # HNSW vector index
├── hnsw-meta.json               # chunk → document mapping
├── graph.json                   # knowledge graph (graphology format)
└── meta.json                    # index metadata (vault path, model, timestamp)
```

### Document Processing Pipeline

#### Step 1: Parse
```
.md file → gray-matter (frontmatter) → remark (AST) → extract:
  - title (frontmatter > first heading > filename)
  - mtime (frontmatter last_updated/updated/date/lastmod → fs.stat mtime)
  - wikilinks ([[note-name]])
  - tags (frontmatter tags: + inline #tags)
  - headers (H1-H6)
  - plain text (markdown stripped)
```

**Frontmatter is optional.** Every note gets a modification timestamp regardless — resolved from frontmatter date fields if present, otherwise from the file's `fs.stat` mtime. When frontmatter fields like `status`, `tier`, `domains`, `load_priority`, or `purpose` are present, they're indexed and exposed through all search tools as filters and score boosters. Plain notes with no frontmatter work exactly as before.

If you want structured frontmatter with a full schema (22 fields, 15 domains, health scoring), [**hit-em-with-the-docs**](https://github.com/TheGlitchKing/hit-em-with-the-docs) is Semantic Pages' **sister plugin** (see [Sister Plugin: hit-em-with-the-docs](#sister-plugin-hit-em-with-the-docs) above). It manages `./.documentation/` as a writer-owned tree; Semantic Pages auto-wires a read-only index of it when both plugins are installed. All hewtd frontmatter fields are natively understood by the indexer.

#### Step 2: Chunk
```
Plain text → split at sentence boundaries → ~512 token chunks
```

#### Step 3: Embed
```
Each chunk → all-MiniLM-L6-v2 (native ONNX) → normalized Float32Array
```

#### Step 4: Index
```
Embeddings → HNSW index (hnswlib-node)
Wikilinks + tags → directed graph (graphology)
```

#### Step 5: Serve
```
MCP tools → query embeddings / graph / files → return results
```

### Using as a Library

The core library is importable independently of the MCP server:

```typescript
import { Indexer, Embedder, GraphBuilder, VectorIndex, TextSearch } from "@theglitchking/semantic-pages";

// Index all notes
const indexer = new Indexer("./vault");
const docs = await indexer.indexAll();

// Build embeddings
const embedder = new Embedder();
await embedder.init();
const chunks = docs.flatMap(d => d.chunks);
const vecs = await embedder.embedBatch(chunks);

// Build vector index
const vectorIndex = new VectorIndex(embedder.getDimensions());
vectorIndex.build(vecs, chunks.map((text, i) => ({
  docPath: docs[Math.floor(i / docs.length)].path,
  chunkIndex: i,
  text
})));

// Search
const queryVec = await embedder.embed("microservices architecture");
const results = vectorIndex.search(queryVec, 5);

// Build knowledge graph
const graph = new GraphBuilder();
graph.buildFromDocuments(docs);
const backlinks = graph.backlinks("project-overview.md");
const path = graph.findPath("overview.md", "auth.md");
```

### Performance

| Metric | Value |
|--------|-------|
| Index 100 notes (~600 chunks) | ~30 seconds |
| Index 500 notes (~3,000 chunks) | ~3–5 minutes |
| Index 2,000 notes (~12,000 chunks) | ~15–20 minutes |
| Semantic search latency | <100ms |
| Text search latency | <10ms |
| Graph traversal latency | <5ms |
| Subsequent server starts (warm cache) | <1 second |
| Model download (first run) | ~22MB, cached at `~/.semantic-pages/models/` |
| Index size (500 notes) | ~30–50MB |
| npm package size | ~112 kB |

---

## Requirements

- **Node.js**: Version 18.0.0 or higher
- **Operating System**: Linux, macOS, or Windows (with WSL2)
- **Disk Space**: ~80MB for the embedding model (downloaded once)

---

## Documentation

Deep-dive guides are in [`.documentation/`](./.documentation/):

- [**How It Works**](./.documentation/how-it-works.md) — architecture, processing pipeline, index format, search mechanics
- [**Frontmatter Guide**](./.documentation/frontmatter-guide.md) — timestamps, load_priority boosting, status/tier/domain filters, hit-em-with-the-docs compatibility
- [**Performance Tuning**](./.documentation/performance-tuning.md) — model selection, batch size, workers, benchmarks
- [**Embedder Guide**](./.documentation/embedder-guide.md) — when/how to tune the embedder, model switching, cache management
- [**Troubleshooting**](./.documentation/troubleshooting.md) — common problems and fixes
- [**Changelog**](./.documentation/changelog.md) — version history with rationale

---

## Troubleshooting

### Installation Issues

**Problem**: `npx semantic-pages` fails or shows "not found"

**Solution**:
```bash
# Clear npx cache and retry
npx --yes semantic-pages --notes ./vault --stats

# Or install globally
npm install -g @theglitchking/semantic-pages
```

**Problem**: Model download fails

**Solution**:
```bash
# Check internet connection, then retry
# The model is cached at ~/.semantic-pages/models/
# Delete and re-download if corrupted:
rm -rf ~/.semantic-pages/models/
semantic-pages --notes ./vault --reindex
```

### Usage Issues

**Problem**: Search returns no results

**Solution**:
```bash
# Force reindex
semantic-pages --notes ./vault --reindex

# Check that .md files exist in the path
ls ./vault/*.md
```

**Problem**: Index seems stale after editing files externally

**Solution**: The file watcher should catch changes, but if it misses some:
```bash
# Force reindex
semantic-pages --notes ./vault --reindex
```

**Problem**: `hnswlib-node` fails to install (native addon)

**Solution**:
```bash
# Install build tools
# On Ubuntu/Debian:
sudo apt install build-essential python3

# On macOS:
xcode-select --install

# Then retry
npm install -g @theglitchking/semantic-pages
```

---

## Contributing

Contributions are welcome! The project uses:
- **TypeScript** with strict mode
- **tsup** for bundling (ESM)
- **vitest** for testing (123 tests across 11 suites)

```bash
# Clone and install
git clone https://github.com/TheGlitchKing/semantic-pages.git
cd semantic-pages
npm install

# Run tests
npm test

# Build
npm run build

# Type check
npm run lint
```

---

## License

MIT License - see [LICENSE](./LICENSE) file for details.

---

## Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/TheGlitchKing/semantic-pages/issues)
- **NPM Package**: [@theglitchking/semantic-pages](https://www.npmjs.com/package/@theglitchking/semantic-pages)
- **Marketplace**: [Glitch Kingdom of Plugins](https://github.com/TheGlitchKing/glitch-kingdom-of-plugins)

---

**Made with care by TheGlitchKing**

[NPM](https://www.npmjs.com/package/@theglitchking/semantic-pages) | [GitHub](https://github.com/TheGlitchKing/semantic-pages) | [Issues](https://github.com/TheGlitchKing/semantic-pages/issues)
