# Performance Tuning

## Measured Baselines

All measurements on a WSL2 machine (Intel CPU, no GPU, 2–4GB RAM available), indexing 2,853 chunks from 582 markdown files:

| Configuration | Time | Notes |
|---|---|---|
| all-MiniLM-L6-v2, batch=16 (default) | ~3–5 min | **Recommended** |
| nomic-embed-text-v1.5, quantized, batch=1 | ~20 min | Higher quality |
| nomic-embed-text-v1.5, fp32, batch=32 | ~25 min | Avoid — padding overhead |
| nomic-embed-text-v1.5, fp32, serial | ~16 min | Old default (pre-0.4.3) |

After the first index, subsequent starts load from cache in under 1 second. The indexing cost is paid once per vault per machine.

---

## Model Selection

### Default: `sentence-transformers/all-MiniLM-L6-v2`

- **Size**: ~22MB ONNX model + ~500KB tokenizer
- **Dimensions**: 384
- **Max sequence**: 128 tokens (longer text is truncated per chunk)
- **Index time**: ~3–5 min for 3,000 chunks on a typical CPU
- **Quality**: Excellent for retrieval tasks. This is one of the most widely deployed sentence embedding models. For developer knowledge bases (code docs, notes, wikis), it performs on par with larger models.
- **When to use**: Default. Suitable for 95% of use cases.

### Alternative: `nomic-ai/nomic-embed-text-v1.5`

- **Size**: ~137MB ONNX model (fp32) / ~34MB (quantized) + tokenizer
- **Dimensions**: 768
- **Max sequence**: 512 tokens (handles longer chunks better)
- **Index time**: ~20 min for 3,000 chunks on a typical CPU
- **Quality**: Higher quality than MiniLM on benchmarks, especially for longer documents and nuanced semantic queries. Noticeable improvement for vaults with long, dense technical writing.
- **When to use**: When search quality matters more than indexing speed, or if your chunks regularly exceed 128 tokens.

```bash
# Use nomic with quantized model for best speed/quality balance
semantic-pages --notes ./vault --model nomic-ai/nomic-embed-text-v1.5 --quantized --batch-size 1 --reindex
```

### Switching Models

Switching models requires a full reindex. The server detects model mismatches via `meta.json` and automatically triggers a reindex if the model changed. You can also force it:

```bash
semantic-pages --notes ./vault --model <new-model> --reindex
```

---

## Batch Size

Batch size controls how many texts are packed into a single ONNX forward pass. The tradeoff:

- **Larger batch** → fewer ONNX calls, but each call processes a padded `[n, max_seq_len]` tensor. If texts vary in length, short texts waste compute on padding tokens.
- **Smaller batch** → more ONNX calls, but each call uses the actual sequence length with no padding waste.

### Measured (realistic long docs, ~300 tokens each):

| Model | Batch=1 | Batch=4 | Batch=8 | Batch=16 |
|---|---|---|---|---|
| MiniLM (128 tok max) | 74ms/text | 71ms/text | 65ms/text | 61ms/text |
| nomic fp32 (512 tok max) | 235ms/text | 279ms/text | 301ms/text | 354ms/text |

**Why batch=16 helps MiniLM but hurts nomic:**
- MiniLM truncates to 128 tokens → short, uniform sequences → minimal padding overhead
- nomic handles up to 512 tokens → long, variable sequences → padding to 512 forces huge wasted compute at large batches

**Recommendation:**
- MiniLM: `--batch-size 16` (default)
- nomic: `--batch-size 1`

---

## Quantized Models

The `--quantized` flag downloads `model_quantized.onnx` (int8 weights) instead of `model.onnx` (fp32):

- Smaller download (~34MB vs ~137MB for nomic)
- Faster inference on CPUs that support int8 SIMD
- Negligible quality loss for retrieval tasks

```bash
# nomic with quantized — best speed/quality balance for that model
semantic-pages --notes ./vault \
  --model nomic-ai/nomic-embed-text-v1.5 \
  --quantized \
  --batch-size 1 \
  --reindex
```

**MiniLM note:** `all-MiniLM-L6-v2` does not publish a quantized ONNX. If you pass `--quantized` with MiniLM, it will automatically fall back to fp32 (you'll see "Quantized model not available, falling back to fp32" in stderr).

---

## Worker Threads

`--workers N` splits the text array across N worker threads, each with its own ONNX session:

```bash
semantic-pages --notes ./vault --workers 2 --reindex
```

**When workers help:** Large vaults (10,000+ chunks) on machines with ≥8GB free RAM and ≥4 CPU cores.

**When workers hurt (the common case):**
- Each worker loads its own ONNX session. MiniLM = ~22MB × N workers. nomic fp32 = ~137MB × N workers.
- On machines with <4GB free RAM, multiple workers cause OS-level page cache thrashing — each worker evicts the other's memory, resulting in 2–3x slower throughput than serial.
- Measured: on a 4GB WSL2 machine, `--workers 4` with nomic was 3x slower than `--workers 1`.

**Rule of thumb:** Only enable if you have (model_size_MB × workers) free RAM with headroom to spare. For MiniLM + 4 workers: need ~100MB — safe on almost any machine.

---

## Large Vault Strategies

### Vault > 1,000 notes

- Use MiniLM (default) — fast enough to index 10,000+ chunks in under 30 minutes
- Add `.semantic-pages-index/` to `.gitignore` — the index is 10–100x the raw text size
- Run `--reindex` overnight or in CI after bulk doc changes
- The file watcher handles day-to-day incremental updates

### Vault > 10,000 notes

- Consider `--workers 2` if you have the RAM
- Consider `--no-watch` during initial index, then restart with watch enabled
- The HNSW index is approximate — search quality stays high at any scale

### Slow first index

The first index is the only time you pay the full embedding cost. After that:
- Server restarts: load from cache (~1 second)
- Single file change: re-embed only that file's chunks (~seconds)
- Bulk add: only new chunks are embedded (existing ones loaded from `embeddings.json`)

---

## .mcp.json Tuning

If you need non-default settings in MCP mode, pass flags through `args`:

```json
{
  "mcpServers": {
    "semantic-pages": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@theglitchking/semantic-pages",
        "--notes", "./vault",
        "--batch-size", "8"
      ]
    }
  }
}
```

For nomic with quantized in MCP:
```json
{
  "args": [
    "-y", "@theglitchking/semantic-pages",
    "--notes", "./vault",
    "--model", "nomic-ai/nomic-embed-text-v1.5",
    "--quantized",
    "--batch-size", "1"
  ]
}
```
