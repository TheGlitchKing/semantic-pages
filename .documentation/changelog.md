# Changelog

## 0.4.3 — Default model switch to MiniLM (current)

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
