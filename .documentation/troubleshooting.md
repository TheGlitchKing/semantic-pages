# Troubleshooting

## Quick Diagnostics

```bash
# Check vault contents and index health
semantic-pages --notes ./vault --stats

# Check what model is currently indexed
cat .semantic-pages-index/meta.json
# → {"model":"sentence-transformers/all-MiniLM-L6-v2","dimensions":384,"totalChunks":312,"indexedAt":"2026-..."}

# Force a clean reindex
semantic-pages --notes ./vault --reindex
```

---

## Installation Problems

### `npx: command not found` or `npx` is very slow

```bash
# Check Node version — must be 18+
node --version

# Use the full package name with scope
npx @theglitchking/semantic-pages --notes ./vault --stats

# Or install globally for faster startup
npm install -g @theglitchking/semantic-pages
semantic-pages --notes ./vault --stats
```

### `hnswlib-node` fails to install (native addon build error)

`hnswlib-node` requires a C++ compiler. Error looks like: `gyp ERR! build error`.

```bash
# Ubuntu / Debian / WSL2
sudo apt install build-essential python3

# macOS
xcode-select --install

# Windows (without WSL2)
npm install --global --production windows-build-tools

# Then retry
npm install -g @theglitchking/semantic-pages
```

### Model download fails on first run

```
Error: Download failed (403): https://huggingface.co/...
```

HuggingFace occasionally rate-limits unauthenticated requests.

```bash
# Wait a few minutes and retry, or set a HF token:
export HF_TOKEN=your_token_here
semantic-pages --notes ./vault --reindex

# If the model file is partially downloaded / corrupted:
rm -rf ~/.semantic-pages/models/
semantic-pages --notes ./vault --reindex
```

---

## Indexing Problems

### Index takes too long

Normal times for the default MiniLM model:
- 100 notes / ~600 chunks: ~30 seconds
- 500 notes / ~3,000 chunks: ~5 minutes
- 2,000 notes / ~12,000 chunks: ~20 minutes

If it's taking much longer, check:

1. **Which model is being used?** nomic takes 4–5x longer than MiniLM.
   ```bash
   # Look for "Embedder ready" line in stderr output
   semantic-pages --notes ./vault --reindex
   # Should say: Embedder ready (all-MiniLM-L6-v2, native, 384d, batch=16)
   ```

2. **Is native ONNX working?** WASM fallback is ~10x slower than native.
   ```bash
   # Confirm it says "native" not "wasm" in the ready message
   # If it says "wasm", install onnxruntime-node:
   npm install -g onnxruntime-node
   ```

3. **Batch size wrong for your model?** See [Performance Tuning](./performance-tuning.md).

### Index stopped mid-way (killed process)

The embedder saves progress every 100 chunks to `embeddings.json`. Resume:

```bash
# Just run reindex again — it picks up where it left off
semantic-pages --notes ./vault --reindex
```

Only chunks that weren't saved will be re-embedded.

### `Model changed ... forcing reindex` on every start

```
Model changed (nomic-ai/nomic-embed-text-v1.5 → sentence-transformers/all-MiniLM-L6-v2), forcing reindex
```

This happens once when upgrading from a version that used nomic as default (pre-0.4.3) to one that uses MiniLM. It's expected — just let the reindex complete. After that, the model matches and subsequent starts load from cache instantly.

If it keeps happening, check that `meta.json` is being written:
```bash
cat .semantic-pages-index/meta.json
# Should contain the current model name
```

---

## Search Problems

### Semantic search returns "Indexing in progress"

The server is still building the index in the background. Wait for indexing to finish. You can poll:

```bash
# Check progress via get_stats tool, or watch stderr:
semantic-pages --notes ./vault 2>&1 | grep -E "(Embedding|ready)"
```

Or use `--reindex` to block until complete before starting the MCP server in your workflow.

### Semantic search returns irrelevant results

**Most common cause**: Query is too short or generic.

- Bad: `search_semantic("auth")` — too broad
- Good: `search_semantic("JWT refresh token rotation strategy")`

**Check your chunk quality:**
```bash
semantic-pages --notes ./vault --stats
# Chunks should be >> notes (typically 5–10x)
# If chunks ≈ notes, your documents are very short
```

**Consider switching to nomic** for better quality on dense technical writing:
```bash
semantic-pages --notes ./vault \
  --model nomic-ai/nomic-embed-text-v1.5 \
  --quantized --batch-size 1 --reindex
```

### Search results are stale after editing files

The file watcher should catch changes within seconds. If it's not:

1. Check the watcher is running (don't use `--no-watch`)
2. Some editors write via temp file rename, which can confuse watchers
3. Force a reindex:
   ```bash
   semantic-pages --notes ./vault --reindex
   ```

### `search_graph` returns no results

Graph traversal requires `[[wikilinks]]` or shared `#tags` to exist. If your notes don't use either:

```bash
# Check graph stats
semantic-pages tools graph_statistics
# If totalEdges: 0, your notes have no links or tags
```

Add wikilinks between related notes: `[[other-note]]` or shared tags in frontmatter: `tags: [backend, api]`.

---

## MCP / Claude Integration Problems

### Claude doesn't see the semantic-pages tools

1. **Check `.mcp.json` syntax** — must be valid JSON with the `mcpServers` key:
   ```json
   {
     "mcpServers": {
       "semantic-pages": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@theglitchking/semantic-pages", "--notes", "./vault"]
       }
     }
   }
   ```

2. **Check the path** — `--notes` must point to a directory that exists:
   ```bash
   ls ./vault  # should list .md files
   ```

3. **Test the server directly** — it should start without errors:
   ```bash
   npx @theglitchking/semantic-pages --notes ./vault 2>&1 | head -5
   # Should see: Embedder ready (all-MiniLM-L6-v2, native, 384d, batch=16)
   ```

### Server crashes immediately on start

```bash
# Run with full error output
node $(npm root -g)/@theglitchking/semantic-pages/dist/cli/index.js \
  --notes ./vault 2>&1
```

Common causes:
- `--notes` path doesn't exist
- Node version < 18
- Corrupted ONNX model file (fix: `rm -rf ~/.semantic-pages/models/`)

### Claude reindexes on every session start

Fixed in v0.4.1. If you're on an older version, upgrade:
```bash
npm install -g @theglitchking/semantic-pages@latest
# or update package.json and bump the version in .mcp.json args
```

---

## Index Corruption

### Reset and rebuild from scratch

```bash
# Delete index (safe — it's fully regenerated from your .md files)
rm -rf .semantic-pages-index/

# Delete cached models if you suspect corruption
rm -rf ~/.semantic-pages/models/

# Full clean rebuild
semantic-pages --notes ./vault --reindex
```

Your markdown files are never modified by semantic-pages. Only the `.semantic-pages-index/` directory and the model cache are managed by the tool.

---

## Getting Help

```bash
# Built-in help
semantic-pages --help
semantic-pages tools                    # list all 21 tools
semantic-pages tools <tool-name>        # args + examples for a specific tool

# Version
semantic-pages --version
```

File a bug: https://github.com/TheGlitchKing/semantic-pages/issues

Include:
- `semantic-pages --version` output
- `node --version` output
- The full error message / stderr output
- Approximate vault size (notes count, chunks from `--stats`)
