import { AutoTokenizer } from "@huggingface/transformers";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

// MiniLM-L6-v2 is the default: ~3 min to index 2,853 chunks on CPU vs ~16 min for nomic.
// nomic-embed-text-v1.5 gives higher quality embeddings but is much slower on CPU.
const DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const CACHE_DIR = join(homedir(), ".semantic-pages", "models");
// Default to 1 worker (serial). Worker threads only help on memory-rich machines
// (each worker loads its own ONNX session). On typical dev machines
// with <4 GB free RAM, parallel workers cause swap thrashing and are slower.
// Enable with --workers N when you have sufficient RAM.
const DEFAULT_WORKERS = 1;
// batch=16 is optimal for MiniLM on CPU (short sequences, low padding waste).
// For larger models (nomic 768d), batch=1 is faster due to padding overhead.
const DEFAULT_BATCH_SIZE = 16;
// Quantized ONNX: faster on CPU but not all models have a quantized variant.
// MiniLM fp32 is already fast enough; nomic benefits from quantized.
// Falls back to fp32 automatically if quantized file is not available.
const DEFAULT_QUANTIZED = false;

// Full-precision ONNX model subpaths
const ONNX_MODEL_PATHS: Record<string, string> = {
  "nomic-ai/nomic-embed-text-v1.5": "onnx/model.onnx",
  "sentence-transformers/all-MiniLM-L6-v2": "onnx/model.onnx",
};

// Quantized (int8) ONNX model subpaths — faster on CPU, ~same quality
const ONNX_QUANTIZED_MODEL_PATHS: Record<string, string> = {
  "nomic-ai/nomic-embed-text-v1.5": "onnx/model_quantized.onnx",
  "sentence-transformers/all-MiniLM-L6-v2": "onnx/model_quantized.onnx",
};

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
  inputNames: string[];
  outputNames: string[];
}

interface OrtModule {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>;
  };
  Tensor: new (type: string, data: ArrayLike<number | bigint>, dims: number[]) => unknown;
}

type RuntimeLabel = "native" | "wasm";

async function resolveOnnxRuntime(): Promise<{ ort: OrtModule; label: RuntimeLabel }> {
  try {
    const ort = await import("onnxruntime-node");
    return { ort: ort as unknown as OrtModule, label: "native" };
  } catch {
    const ort = await import("onnxruntime-web");
    return { ort: ort as unknown as OrtModule, label: "wasm" };
  }
}

// Download to a process-unique temp file, then atomically rename onto the
// final path. Two concurrent downloaders won't corrupt each other's partial
// writes — the worst case is one wasted download (rename is last-writer-wins
// but each rename installs a complete, valid file). Without this, multiple
// processes calling Embedder.init() against the same cache (e.g. parallel
// vitest workers, or multiple semantic-pages servers on a fresh install) race
// on a single shared writeStream and produce a corrupt ONNX file that fails
// Protobuf parsing on load.
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  if (!response.body) throw new Error(`No response body: ${url}`);
  const tempPath = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fileStream = createWriteStream(tempPath);
    await streamPipeline(Readable.fromWeb(response.body as never), fileStream);
    await rename(tempPath, destPath);
  } catch (err) {
    try { await unlink(tempPath); } catch { /* temp may not exist */ }
    throw err;
  }
}

export class Embedder {
  private model: string;
  private session: OrtSession | null = null;
  private tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;
  private ort: OrtModule | null = null;
  private dimensions = 0;
  private runtimeLabel: RuntimeLabel = "wasm";
  private initialized = false;
  private numWorkers: number;
  private batchSize: number;
  private quantized: boolean;
  private modelPath = "";

  constructor(
    model: string = DEFAULT_MODEL,
    numWorkers: number = DEFAULT_WORKERS,
    batchSize: number = DEFAULT_BATCH_SIZE,
    quantized: boolean = DEFAULT_QUANTIZED
  ) {
    this.model = model;
    this.numWorkers = numWorkers;
    this.batchSize = batchSize;
    this.quantized = quantized;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const modelDir = join(CACHE_DIR, this.model.replace(/\//g, "--"));
    await mkdir(modelDir, { recursive: true });

    // Resolve ONNX runtime (native C++ or WASM fallback)
    const { ort, label } = await resolveOnnxRuntime();
    this.ort = ort;
    this.runtimeLabel = label;

    // Download ONNX model if not cached. Tries quantized first if requested,
    // falls back to fp32 if the quantized file is not available for this model.
    let useQuantized = this.quantized;
    const modelFileName = useQuantized ? "model_quantized.onnx" : "model.onnx";
    this.modelPath = join(modelDir, modelFileName);
    const modelPath = this.modelPath;
    if (!existsSync(modelPath)) {
      const pathMap = useQuantized ? ONNX_QUANTIZED_MODEL_PATHS : ONNX_MODEL_PATHS;
      const onnxSubpath = pathMap[this.model] ?? (useQuantized ? "onnx/model_quantized.onnx" : "onnx/model.onnx");
      const url = `https://huggingface.co/${this.model}/resolve/main/${onnxSubpath}`;
      process.stderr.write(`Downloading ONNX model: ${this.model} (${useQuantized ? "quantized" : "fp32"})...\n`);
      try {
        await downloadFile(url, modelPath);
      } catch (err: any) {
        if (useQuantized && err?.message?.includes("404")) {
          // Quantized not available for this model — fall back to fp32
          process.stderr.write(`Quantized model not available, falling back to fp32\n`);
          useQuantized = false;
          this.modelPath = join(modelDir, "model.onnx");
          const fp32Subpath = ONNX_MODEL_PATHS[this.model] ?? "onnx/model.onnx";
          const fp32Url = `https://huggingface.co/${this.model}/resolve/main/${fp32Subpath}`;
          process.stderr.write(`Downloading ONNX model: ${this.model} (fp32)...\n`);
          await downloadFile(fp32Url, this.modelPath);
        } else {
          throw err;
        }
      }
      process.stderr.write(`Model downloaded to ${modelDir}\n`);
    }
    // Load tokenizer (uses HF transformers tokenizer infrastructure)
    this.tokenizer = await AutoTokenizer.from_pretrained(this.model, {
      cache_dir: CACHE_DIR,
    });

    // Create ONNX inference session (use this.modelPath — may have been updated by fallback)
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: [label === "native" ? "cpu" : "wasm"],
    });

    // Determine dimensions from a test embedding
    const test = await this.embed("test");
    this.dimensions = test.length;
    this.initialized = true;

    const modelShort = this.model.split("/").pop() ?? this.model;
    process.stderr.write(`Embedder ready (${modelShort}, ${label}, ${this.dimensions}d, batch=${this.batchSize})\n`);
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.session || !this.tokenizer || !this.ort)
      throw new Error("Embedder not initialized. Call init() first.");

    // Tokenize
    const encoded = await this.tokenizer(text, {
      padding: true,
      truncation: true,
      max_length: 512,
      return_tensor: false,
    });

    const inputIdsRaw: number[] = Array.from(encoded.input_ids.data ?? encoded.input_ids);
    const attentionMaskRaw: number[] = Array.from(encoded.attention_mask.data ?? encoded.attention_mask);
    const seqLen = inputIdsRaw.length;

    // Build ONNX input tensors (most models expect int64)
    const inputIds = new this.ort.Tensor(
      "int64",
      BigInt64Array.from(inputIdsRaw.map(BigInt)),
      [1, seqLen]
    );
    const attentionMask = new this.ort.Tensor(
      "int64",
      BigInt64Array.from(attentionMaskRaw.map(BigInt)),
      [1, seqLen]
    );

    const feeds: Record<string, unknown> = { input_ids: inputIds, attention_mask: attentionMask };

    // Some models need token_type_ids
    if (this.session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new this.ort.Tensor(
        "int64",
        new BigInt64Array(seqLen),
        [1, seqLen]
      );
    }

    // Run inference
    const output = await this.session.run(feeds);
    const outputTensor = output[this.session.outputNames[0]];
    const hiddenSize = outputTensor.dims[outputTensor.dims.length - 1];

    // Mean pooling with attention mask + L2 normalization
    return this.meanPoolAndNormalize(outputTensor.data, attentionMaskRaw, seqLen, hiddenSize);
  }

  private meanPoolAndNormalize(
    embeddings: Float32Array,
    attentionMask: number[],
    seqLen: number,
    hiddenSize: number
  ): Float32Array {
    const result = new Float32Array(hiddenSize);
    let maskSum = 0;

    for (let t = 0; t < seqLen; t++) {
      const mask = attentionMask[t];
      maskSum += mask;
      const offset = t * hiddenSize;
      for (let d = 0; d < hiddenSize; d++) {
        result[d] += embeddings[offset + d] * mask;
      }
    }

    if (maskSum > 0) {
      for (let d = 0; d < hiddenSize; d++) result[d] /= maskSum;
    }

    // L2 normalize
    let norm = 0;
    for (let d = 0; d < hiddenSize; d++) norm += result[d] * result[d];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < hiddenSize; d++) result[d] /= norm;
    }

    return result;
  }

  // Mean pool + L2 normalize the output of a batched ONNX forward pass.
  // outputData: flat Float32Array of shape [batchSize, seqLen, hiddenSize]
  // maskData:   flat number[] of shape [batchSize, seqLen]
  private meanPoolAndNormalizeMany(
    outputData: Float32Array,
    maskData: number[],
    batchSize: number,
    seqLen: number,
    hiddenSize: number
  ): Float32Array[] {
    const results: Float32Array[] = [];
    for (let b = 0; b < batchSize; b++) {
      const result = new Float32Array(hiddenSize);
      let maskSum = 0;
      for (let t = 0; t < seqLen; t++) {
        const mask = maskData[b * seqLen + t];
        maskSum += mask;
        const offset = (b * seqLen + t) * hiddenSize;
        for (let d = 0; d < hiddenSize; d++) {
          result[d] += outputData[offset + d] * mask;
        }
      }
      if (maskSum > 0) {
        for (let d = 0; d < hiddenSize; d++) result[d] /= maskSum;
      }
      // L2 normalize
      let norm = 0;
      for (let d = 0; d < hiddenSize; d++) norm += result[d] * result[d];
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let d = 0; d < hiddenSize; d++) result[d] /= norm;
      }
      results.push(result);
    }
    return results;
  }

  // Embed a sub-batch of texts (length <= batchSize) in a single ONNX forward pass.
  //
  // Tokenizes each text individually (well-defined output format for all HF versions),
  // then manually pads to the longest sequence in the batch and builds a [n, seqLen]
  // tensor for one ONNX call. The speedup is from batching the ONNX inference —
  // individual tokenization is negligible (<1ms each).
  private async embedSubBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.session || !this.tokenizer || !this.ort)
      throw new Error("Embedder not initialized. Call init() first.");

    const n = texts.length;

    // Tokenize each text individually — avoids ambiguous batch tokenizer output format
    const encodings = await Promise.all(
      texts.map((text) =>
        this.tokenizer!(text, {
          padding: false,
          truncation: true,
          max_length: 512,
          return_tensor: false,
        })
      )
    );

    // Extract flat token arrays and find max sequence length for this batch
    const tokenized = encodings.map((enc) => ({
      ids: Array.from(enc.input_ids.data ?? enc.input_ids) as number[],
      mask: Array.from(enc.attention_mask.data ?? enc.attention_mask) as number[],
    }));
    const seqLen = Math.max(...tokenized.map((t) => t.ids.length));

    // Build flat padded tensors [n * seqLen] — pad with 0 (PAD token, zero attention)
    const flatIds = new BigInt64Array(n * seqLen);
    const flatMask = new BigInt64Array(n * seqLen);
    const flatMaskNums = new Array<number>(n * seqLen).fill(0);

    for (let i = 0; i < n; i++) {
      const { ids, mask } = tokenized[i];
      for (let j = 0; j < ids.length; j++) {
        flatIds[i * seqLen + j] = BigInt(ids[j]);
        flatMask[i * seqLen + j] = BigInt(mask[j]);
        flatMaskNums[i * seqLen + j] = mask[j];
      }
      // Positions beyond ids.length remain 0 (padding)
    }

    // Build batched ONNX tensors [n, seqLen]
    const inputIds = new this.ort.Tensor("int64", flatIds, [n, seqLen]);
    const attentionMask = new this.ort.Tensor("int64", flatMask, [n, seqLen]);

    const feeds: Record<string, unknown> = { input_ids: inputIds, attention_mask: attentionMask };

    if (this.session.inputNames.includes("token_type_ids")) {
      feeds.token_type_ids = new this.ort.Tensor(
        "int64",
        new BigInt64Array(n * seqLen),
        [n, seqLen]
      );
    }

    // Single forward pass → output shape [n, seqLen, hiddenSize]
    const output = await this.session.run(feeds);
    const outputTensor = output[this.session.outputNames[0]];
    const hiddenSize = outputTensor.dims[outputTensor.dims.length - 1];

    return this.meanPoolAndNormalizeMany(
      outputTensor.data,
      flatMaskNums,
      n,
      seqLen,
      hiddenSize
    );
  }

  async embedBatch(
    texts: string[],
    onProgress?: (embedded: number, total: number, subBatch?: Float32Array[]) => Promise<void> | void
  ): Promise<Float32Array[]> {
    // Workers path (disabled by default; kept for --workers N users)
    if (this.numWorkers > 1 && texts.length >= this.numWorkers * 2) {
      return this.embedBatchParallel(texts, onProgress);
    }

    // True batched inference: slice into sub-batches and run one ONNX call each
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const subBatch = texts.slice(i, i + this.batchSize);
      const embeddings = await this.embedSubBatch(subBatch);
      results.push(...embeddings);
      await onProgress?.(Math.min(i + subBatch.length, texts.length), texts.length, embeddings);
    }
    return results;
  }

  private async embedBatchParallel(
    texts: string[],
    onProgress?: (embedded: number, total: number, subBatch?: Float32Array[]) => Promise<void> | void
  ): Promise<Float32Array[]> {
    // Resolve worker script path. With tsup splitting, embedder code may land
    // in a top-level chunk (dist/chunk-*.js) rather than dist/core/index.js,
    // so we try two locations: adjacent to this chunk, and dist/core/ relative
    // to the package root (two levels up from a dist/ chunk file).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    let workerPath = join(thisDir, "embed-worker.js");
    if (!existsSync(workerPath)) {
      // Chunk file at dist/ level — worker is in dist/core/
      workerPath = join(thisDir, "core", "embed-worker.js");
    }

    if (!existsSync(workerPath)) {
      // Fallback to serial batched if worker script not found
      process.stderr.write("Worker script not found, falling back to batched embedding\n");
      return this.embedBatch(texts, onProgress);
    }

    // Split texts into chunks for each worker
    const chunkSize = Math.ceil(texts.length / this.numWorkers);
    const chunks: { texts: string[]; startIndex: number }[] = [];
    for (let i = 0; i < texts.length; i += chunkSize) {
      chunks.push({ texts: texts.slice(i, i + chunkSize), startIndex: i });
    }

    const allResults = new Array<Float32Array>(texts.length);
    let totalDone = 0;

    const workerPromises = chunks.map((chunk) => {
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: {
            modelPath: this.modelPath,
            modelName: this.model,
            cacheDir: CACHE_DIR,
            runtimeLabel: this.runtimeLabel,
            batchSize: this.batchSize,
          },
        });

        worker.on("message", (msg: any) => {
          if (msg.type === "ready") {
            worker.postMessage({ type: "embed", texts: chunk.texts, startIndex: chunk.startIndex });
          } else if (msg.type === "progress") {
            totalDone++;
            onProgress?.(totalDone, texts.length);
          } else if (msg.type === "result") {
            for (let i = 0; i < msg.embeddings.length; i++) {
              allResults[chunk.startIndex + i] = new Float32Array(msg.embeddings[i]);
            }
            worker.terminate();
            resolve();
          } else if (msg.type === "error") {
            worker.terminate();
            reject(new Error(msg.error));
          }
        });

        worker.on("error", (err) => {
          worker.terminate();
          reject(err);
        });
      });
    });

    await Promise.all(workerPromises);
    return allResults;
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
  }

  getRuntime(): RuntimeLabel {
    return this.runtimeLabel;
  }

  async saveEmbeddings(
    embeddings: Map<string, Float32Array>,
    indexPath: string
  ): Promise<void> {
    const entries: Array<{ key: string; data: number[] }> = [];
    for (const [key, vec] of embeddings) {
      entries.push({ key, data: Array.from(vec) });
    }
    await writeFile(join(indexPath, "embeddings.json"), JSON.stringify(entries));
  }

  async loadEmbeddings(
    indexPath: string
  ): Promise<Map<string, Float32Array>> {
    const filePath = join(indexPath, "embeddings.json");
    if (!existsSync(filePath)) return new Map();

    const raw = await readFile(filePath, "utf-8");
    const entries: Array<{ key: string; data: number[] }> = JSON.parse(raw);
    const map = new Map<string, Float32Array>();
    for (const entry of entries) {
      map.set(entry.key, new Float32Array(entry.data));
    }
    return map;
  }
}
