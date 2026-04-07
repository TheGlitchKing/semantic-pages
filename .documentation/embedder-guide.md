# Embedder Guide — When and How to Tune

## The Embedder's Job

The embedder converts text into a fixed-size vector (a list of numbers) that encodes meaning. Two texts that mean similar things will have vectors that point in similar directions (high cosine similarity). The quality of semantic search depends entirely on how well the embedding model captures meaning for your specific content.

The `Embedder` class (`src/core/embedder.ts`) handles:
1. Tokenization (splitting text into tokens the model understands)
2. ONNX inference (running the transformer model locally)
3. Mean pooling (collapsing `[seq_len, hidden_size]` → `[hidden_size]`)
4. L2 normalization (making all vectors unit length for cosine similarity)

---

## When to Leave it Alone

The default settings (`all-MiniLM-L6-v2`, batch=16) work well for:

- Developer knowledge bases (code docs, architecture notes, runbooks)
- Project wikis and meeting notes
- Personal knowledge management (Obsidian-style vaults)
- Any vault where documents are mostly English prose under 500 words

If search results feel accurate and indexing completes in a reasonable time, leave it alone.

---

## When to Tune

### Switch to nomic when:

- Search results feel imprecise for nuanced queries
- Your documents are long and dense (research papers, detailed specs)
- You have documents that regularly fill or exceed the 128-token MiniLM limit
- You're using the vault for research synthesis rather than quick lookup

```bash
semantic-pages --notes ./vault \
  --model nomic-ai/nomic-embed-text-v1.5 \
  --quantized \
  --batch-size 1 \
  --reindex
```

nomic processes up to 512 tokens per chunk (vs MiniLM's 128), so it handles longer, more detailed writing better.

### Switch to MiniLM when:

- Indexing is too slow for your workflow
- You're on a low-RAM machine (<4GB)
- Search quality is good enough for your use case
- You're iterating rapidly and need fast reindexes

MiniLM is the default. No flag needed.

### Adjust batch size when:

You're seeing slower-than-expected indexing. Run the rule of thumb:
- **nomic (long sequences)**: use `--batch-size 1`
- **MiniLM (short sequences)**: use `--batch-size 16` (default) or higher

See [Performance Tuning](./performance-tuning.md) for measured benchmarks.

### Enable workers when:

You have a very large vault (10,000+ notes) and >8GB RAM free. Workers parallelize the embedding work across multiple ONNX sessions.

```bash
semantic-pages --notes ./vault --workers 2 --reindex
```

Never enable workers if RAM is tight — it's slower, not faster.

---

## How the Embedder is Configured

### Via CLI flags

All options are available as CLI flags on both `serve` and `--reindex` commands:

| Flag | Default | Description |
|---|---|---|
| `--model <name>` | `sentence-transformers/all-MiniLM-L6-v2` | HuggingFace model ID |
| `--batch-size <n>` | `16` | Texts per ONNX forward pass |
| `--quantized` | off | Use int8 quantized model (faster on CPU, not all models support it) |
| `--no-quantized` | — | Explicit fp32 (default behavior) |
| `--workers <n>` | `1` | Worker threads for parallel embedding |

### Via `.mcp.json`

Pass flags through the `args` array:

```json
{
  "mcpServers": {
    "semantic-pages": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "@theglitchking/semantic-pages",
        "--notes", "./vault",
        "--model", "nomic-ai/nomic-embed-text-v1.5",
        "--quantized",
        "--batch-size", "1"
      ]
    }
  }
}
```

### Via the library API

```typescript
import { Embedder } from "@theglitchking/semantic-pages";

// Signature:
// new Embedder(model?, numWorkers?, batchSize?, quantized?)

// Default (MiniLM, batch=16, fp32)
const embedder = new Embedder();

// nomic quantized, batch=1
const embedder = new Embedder(
  "nomic-ai/nomic-embed-text-v1.5",
  1,   // workers
  1,   // batch size
  true // quantized
);

await embedder.init();
const vec = await embedder.embed("single query text");
const vecs = await embedder.embedBatch(["text1", "text2", ...]);
```

---

## How the Inference Loop Works

Understanding this helps when diagnosing slow indexing.

### `embedBatch(texts, onProgress)` — entry point

Called with all pending chunks at once (e.g., 2,853 texts for the full corpus). Internally slices into sub-batches of `batchSize`:

```
texts (2853) → slice into sub-batches of 16
             → embedSubBatch([16 texts]) → 16 Float32Arrays
             → embedSubBatch([16 texts]) → 16 Float32Arrays
             → ...
             → returns all 2853 Float32Arrays
```

### `embedSubBatch(texts[])` — one ONNX call

```
1. tokenize each text individually (Promise.all)
   - individual tokenization avoids ambiguous batch output formats
   - fast: ~1-5ms per text
2. find max seq_len in this sub-batch
3. build padded flat tensors:
   - flatIds:  BigInt64Array [n * seqLen]  — token IDs, zero-padded
   - flatMask: BigInt64Array [n * seqLen]  — attention mask (1=real, 0=pad)
4. create ONNX Tensors: input_ids [n, seqLen], attention_mask [n, seqLen]
5. session.run() → output [n, seqLen, hiddenSize]
6. meanPoolAndNormalizeMany() → n Float32Arrays
```

### `meanPoolAndNormalizeMany()` — post-processing

For each of the n samples in the batch:
1. Weighted mean across the sequence dimension (weights = attention mask)
   - Padding tokens contribute nothing (mask=0)
   - Real tokens are averaged together
2. L2 normalize the resulting vector

This produces a unit vector that encodes the "average meaning" of all real tokens in the sequence.

---

## Changing Models: What Happens to the Index

When you change the `--model` flag:

1. Server starts → loads `meta.json` → sees model name mismatch
2. Logs: `Model changed (old-model → new-model), forcing reindex`
3. Discards cached HNSW index and graph
4. Downloads new model if not cached
5. Re-embeds all documents with the new model
6. Saves new index with updated `meta.json`

**The change is safe.** Your markdown files are never modified. Only `.semantic-pages-index/` is updated.

**Dimensions change between models:**
- MiniLM: 384 dimensions
- nomic: 768 dimensions

The HNSW index is model-specific and cannot be reused after a model switch.

---

## Model Cache Location

All models are cached at `~/.semantic-pages/models/`:

```
~/.semantic-pages/models/
├── sentence-transformers--all-MiniLM-L6-v2/
│   └── model.onnx                           # ~22MB
├── sentence-transformers/                   # HF tokenizer cache
│   └── ...                                  # ~500KB
├── nomic-ai--nomic-embed-text-v1.5/
│   ├── model.onnx                           # ~137MB (fp32)
│   └── model_quantized.onnx                 # ~34MB (int8)
└── nomic-ai/                                # HF tokenizer cache
    └── ...                                  # ~500MB
```

To free disk space, delete models you're not using:
```bash
# Remove nomic (if using MiniLM default)
rm -rf ~/.semantic-pages/models/nomic-ai--nomic-embed-text-v1.5/
rm -rf ~/.semantic-pages/models/nomic-ai/

# Remove all (will re-download on next use)
rm -rf ~/.semantic-pages/
```
