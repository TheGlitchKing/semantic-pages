# Changelog

> Note: This changelog has gaps between 0.4.3 and 0.6.2 — entries for 0.5.0,
> 0.6.0, and 0.6.1 were not written at the time of release and need to be
> backfilled from git history. See `git log v0.4.3..v0.6.0` for context.

## 0.9.0 — Extract shared runtime *(current)*

No behavior change from 0.8.0 — a pure refactor that moves the generic
plugin-lifecycle code to a shared package so other Glitch Kingdom plugins
can adopt the same pattern.

**Adopted `@theglitchking/claude-plugin-runtime@^0.1.0`:**
- `scripts/link-skills.js` shrunk from 180 lines → 20 — now a thin
  `runPostinstall(...)` call.
- `hooks/session-start.js` shrunk from 220 lines → 13. The plugin-specific
  `.mcp.json` reconciliation moved to `hooks/reconcile.js` and is passed
  to the runtime as the `reconcile` option.
- CLI `update` / `policy` / `status` / `relink` subcommands shrunk from
  ~120 lines → 6 — now a single `registerUpdateCommands(program, ...)`
  call.

Validated against the full 10-test smoke matrix (fresh install,
idempotent re-install, plugin-enabled dedup, skip envs, dev-in-place
no-self-link, session-start with each policy).

Reference implementation of the runtime. See
[claude-plugin-runtime's `PLUGIN_AUTHORING_SCAFFOLD.md`](https://github.com/TheGlitchKing/claude-plugin-runtime/blob/main/docs/PLUGIN_AUTHORING_SCAFFOLD.md)
for the authoring recipe.

---

## 0.8.0 — SessionStart update policy + skill auto-link

Defaults are conservative (nudge-only), so existing installs behave the
same until the user opts in.

**Postinstall:**
- Symlinks every directory under the package's `skills/` into
  `<project>/.claude/skills/` so Claude Code can discover bundled skills
  (it does not scan `node_modules/`). The link is relative and refreshed
  on every install. Non-symlinks at the destination are preserved with a
  warning. Dev-in-place (`INIT_CWD` equals the package root) is a no-op.
- Writes `<project>/.claude/semantic-pages.json` with
  `{ "updatePolicy": "nudge" }` if one doesn't exist yet.
- Registers a SessionStart hook in `<project>/.claude/settings.json`
  **only if** settings.json already exists, the marketplace plugin isn't
  already enabled globally, and no matching hook is already registered.

**SessionStart hook (`hooks/session-start.js`, Node, replaces the bash
version):**
- Reconciles `.mcp.json` (same wiring as before — `semantic-vault` plus
  conditional `semantic-pages` read-only docs entry).
- Checks npm for a newer version and acts per policy:
  - `nudge` (default) — prints a one-liner via `additionalContext`.
  - `auto` — runs `npm update`, re-links skills, prints an upgrade
    confirmation.
  - `off` — silent, no network call.
- 3s network budget, 6h cache, CI-skip, fail-open on any error.
- Dedup: when invoked as the marketplace plugin (`CLAUDE_PLUGIN_ROOT`
  set) and the project has its own SessionStart entry containing
  `semantic-pages`, the plugin instance defers.

**New slash + CLI commands:**
- `/semantic-pages:update` / `semantic-pages update`
- `/semantic-pages:policy [auto|nudge|off]` / `semantic-pages policy`
- `/semantic-pages:status` / `semantic-pages status`
- `/semantic-pages:relink` / `semantic-pages relink`

**Env opt-outs:**
- `SEMANTIC_PAGES_UPDATE_POLICY` — one-shot policy override.
- `SEMANTIC_PAGES_SKIP_LINK=1` — skip skill symlinking in postinstall.
- `SEMANTIC_PAGES_SKIP_HOOK_REGISTER=1` — skip settings.json hook
  registration.

**README:**
- New "Update Policy & Session-Start Hook" section covering policies,
  config path, env overrides, dedup, and uninstall procedure.
- Install methods reordered: Method B (project-level npm) promoted to
  "recommended for teams and AI-assisted projects"; Method E (global
  install) flagged as not recommended.

**Runbook:**
- Added the npm publish checklist to
  `.claude/rules/operational-runbook.md` — CLI version sync via
  `createRequire`, build cleanliness, npx cache flush.

---

## 0.6.4 — Lifecycle fix

**Fixed orphan-process accumulation.** In some MCP stdio configurations
the server wouldn't exit when the client closed the connection, leaving
chokidar's `FSWatcher` (inotify fds) and ONNX's native thread pool
keeping the event loop alive. On a low-memory host this accumulated to
63 processes and exhausted RAM+swap.

- Added stdin EOF + SIGTERM/SIGHUP handlers in `startServer()` that
  `process.exit(0)` on client disconnect.
- New e2e test suite `test/e2e/stdin-eof.test.ts` covers both stdin
  close and SIGTERM paths.
- Small diff, no public surface change.

**Also in this release:** fixed the CLI `--version` flag to read from
`package.json` dynamically via `createRequire(import.meta.url)` so it
never lies about the installed version.

---

## 0.6.3 — Documentation catch-up

Docs-only patch. No code or test changes — the package is functionally
identical to 0.6.2.

**README:**
- Added `--wait-for-ready` to the CLI command table
- Added a "When to use it" detail section for `--wait-for-ready` matching
  the existing pattern for `--reindex` / `--stats` / `--no-watch`
- Added a new "## Bundled Skills" section documenting `semantic-first` —
  the Claude Code skill that has been shipping in the npm tarball since
  0.6.1 but had no README mention until now. Covers what it is, the two
  flows (docs lookup + research notes), where it lives in the package
  (`skills/semantic-first/`), and the gating behavior with respect to the
  `hit-em-with-the-docs` companion plugin

**Changelog:**
- Added this 0.6.3 entry
- Added the 0.6.2 entry below
- Flagged the 0.5.0 / 0.6.0 / 0.6.1 historical gap so it can be backfilled
  in a future session

---

## 0.6.2 — Test suite repair + 3 real bug fixes

Goes from "22 failing / 14 skipped / 101 passing" to **137 passing**
(13/13 test files), and surfaces three real production bugs along the way.

**Real code fixes:**

- **`src/core/embedder.ts` — atomic ONNX model download.** The previous
  `downloadFile()` opened a writeStream on the final destination path, so
  two concurrent processes calling `Embedder.init()` raced on the same
  file and produced a corrupt ONNX that failed Protobuf parsing on load.
  This trivially reproduced in the test suite (multiple parallel test
  files all trying to download to `~/.semantic-pages/models/`), but also
  affects real users who run multiple `semantic-pages` instances on a
  fresh install. Fixed by writing to a process-unique temp path and
  atomically renaming onto the final path. Worst case is one wasted
  download, never a corrupt artifact.
- **`src/core/indexer.ts` — symlinked directories now indexed.**
  `indexAll()` called `glob("**/*.md", { cwd })` without `follow: true`,
  so any notes inside a symlinked subdirectory were silently invisible
  to the indexer. This broke the documented "share notes across vaults
  via symlink" use case. Fixed by adding `follow: true`. `glob` does
  inode-based cycle detection, so circular symlinks are still safe.
- **`src/mcp/server.ts` — `tryLoadCachedIndex` now reports `"ready"` when
  the cache matches disk.** Previous behavior unconditionally set
  `indexState = "stale"` after a successful cache load, which (a) misled
  `get_stats` callers into thinking a perfectly usable index was unsafe,
  and (b) made the state machine non-promotable — short of a full
  reindex, there was no path from `stale` to `ready`. Now the function
  does a freshness check by comparing the cached `totalChunks` against
  the current chunk count on disk: match → `ready`; mismatch → still
  serve cached data but mark `stale` so callers know a refresh is
  desirable. We deliberately don't auto-reindex on stale because that
  defeats the point of caching; the file watcher catches real changes
  during normal operation.

**New CLI feature:**

- **`--wait-for-ready` flag.** Previously the only way to know an MCP
  server had finished indexing was to poll `get_stats`. Users scripting
  semantic-pages now have a way to block startup until the index is
  fully built. The default behavior (background indexing) is unchanged.

**Test infrastructure:**

- Added vitest `globalSetup` that pre-downloads the ONNX model once
  before any test files run. Combined with the atomic-rename fix,
  parallel test files now share the cached model instead of all racing
  to download. Suite duration dropped from ~132s to ~18s.
- Updated three test files for behaviors that had drifted: `crud.test.ts`
  (auto-stamped frontmatter on update, expected behavior since 21b84c8),
  `stdio-server.test.ts` (default model `nomic` → `MiniLM`), and
  `mcp-server.test.ts` + `stdio-server.test.ts` (use `waitForReady` so
  they don't race against background indexing).

---

## 0.4.3 — Default model switch to MiniLM

**Breaking change**: Default embedding model changed from `nomic-ai/nomic-embed-text-v1.5` to `sentence-transformers/all-MiniLM-L6-v2`.

**Impact on existing users**: On first start after upgrading, the server detects a model mismatch in `meta.json` and automatically triggers a one-time background reindex. Indexing completes in ~3–5 minutes. After that, subsequent starts load from cache instantly.

**Why this change:**

Benchmarked on a 2,853-chunk corpus (582 docs, WSL2, no GPU):

| Model | Time |
|---|---|
| nomic fp32, batch=32 (pre-0.4.0 equivalent) | ~16 min |
| nomic fp32, batch=32 (0.4.0) | ~25 min (regression) |
| nomic quantized, batch=8 (0.4.2) | ~21 min |
| **MiniLM fp32, batch=16 (0.4.3)** | **~3–5 min** |

MiniLM also produces a smaller index (384d vs 768d) and a smaller model file (22MB vs 137MB+).

**Other changes:**
- `DEFAULT_BATCH_SIZE`: 32 → 16 (MiniLM benefits from batching; nomic does not)
- `DEFAULT_QUANTIZED`: true → false (MiniLM has no quantized ONNX)
- Graceful quantized fallback: if `model_quantized.onnx` returns 404, auto-downloads fp32
- Ready message now shows short model name: `all-MiniLM-L6-v2, native, 384d, batch=16`
- Removed unused `cpus` import from `embedder.ts`
- nomic still fully supported via `--model nomic-ai/nomic-embed-text-v1.5`

---

## 0.4.2 — Quantized model support

- Added `--quantized` / `--no-quantized` CLI flag
- `DEFAULT_QUANTIZED = true`: downloads `model_quantized.onnx` (int8) instead of `model.onnx` (fp32) for nomic
- `DEFAULT_BATCH_SIZE`: 32 → 8 (reduced padding overhead)
- Quantized model path: `onnx/model_quantized.onnx` on HuggingFace
- `quantized` option threaded through `ServerOptions` → `Embedder` constructor
- Ready message includes quantized/fp32 status

*Note: Benchmarks showed this was still slower than MiniLM. Superseded by 0.4.3.*

---

## 0.4.1 — Fix reindex-on-every-session-start

**Bug fix**: The MCP server was triggering a full background reindex on every session start, even when a valid cached index existed. This caused a 15–25 minute wait on every Claude Code session startup.

**Root cause** (`src/mcp/server.ts`):
```typescript
// Before (broken): always reindexed, cache load was wasted
const cached = await tryLoadCachedIndex();
backgroundIndex(); // fired unconditionally

// After (fixed): only reindex if cache miss
const cached = await tryLoadCachedIndex();
if (!cached) {
  backgroundIndex();
}
// If cache loaded, serve immediately. Watcher handles incremental updates.
```

**Behavior after fix:**
- Warm cache (index exists, model matches): server ready in <1 second
- Cold start (no index) or model mismatch: background index starts, server serves search once ready
- File changes: watcher triggers incremental reindex of changed files only
- `--reindex` flag: always does a full blocking reindex before serving

---

## 0.4.0 — Batched ONNX inference

**Architecture change**: Replaced per-document embedding with corpus-wide batched inference.

**Before**: The indexing loop called `embedBatch` once per document (~5 chunks at a time). Even with `batchSize=32`, effective batch sizes were 5, not 32.

**After**: All pending chunks across all documents are collected first, then `embedBatch` is called once with all of them. This enables true `batchSize`-wide ONNX calls.

**Other changes:**
- Added `embedSubBatch()`: tokenizes each text individually (avoids ambiguous batch tokenizer output), manually pads to max seq_len in batch, runs single `[n, seqLen]` ONNX call
- Added `meanPoolAndNormalizeMany()`: batched mean pooling + L2 normalize
- `embedBatch` progress callback now receives the just-completed sub-batch's `Float32Array[]` for incremental saving
- `DEFAULT_BATCH_SIZE = 32` (later revised down in 0.4.2 and 0.4.3)
- Added `--batch-size <n>` CLI flag
- `batchSize` threaded through `ServerOptions` → `Embedder` constructor

*Note: The batch=32 default caused padding overhead that made nomic indexing slower than the original serial approach. Fixed in 0.4.2/0.4.3.*

---

## 0.3.2 — Fix worker swap thrashing

- `DEFAULT_WORKERS`: 4 → 1
- **Why**: On machines with <4GB free RAM, 4 parallel ONNX workers (each loading ~400MB for nomic) caused OS swap thrashing — 3x slower than serial. Workers only help when `N_workers × model_size_MB` fits comfortably in free RAM.
- Workers remain available via `--workers N` for RAM-rich machines.

---

## 0.3.1 — Fix worker script path resolution

- **Bug**: With `tsup` code splitting enabled, the embedder code lands in `dist/chunk-*.js` (not `dist/core/index.js`). `import.meta.url` in a chunk file resolves to `dist/`, not `dist/core/`, so the worker script path `join(thisDir, "embed-worker.js")` pointed to a non-existent location.
- **Fix**: Added fallback path check: tries `dist/embed-worker.js`, then `dist/core/embed-worker.js`.
