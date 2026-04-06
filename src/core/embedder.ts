import { AutoTokenizer } from "@huggingface/transformers";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync, createWriteStream } from "node:fs";
import { homedir, cpus } from "node:os";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const CACHE_DIR = join(homedir(), ".semantic-pages", "models");
const DEFAULT_WORKERS = Math.min(cpus().length, 4);

// ONNX model file paths per known model
const ONNX_MODEL_PATHS: Record<string, string> = {
  "nomic-ai/nomic-embed-text-v1.5": "onnx/model.onnx",
  "sentence-transformers/all-MiniLM-L6-v2": "onnx/model.onnx",
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

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  if (!response.body) throw new Error(`No response body: ${url}`);
  const fileStream = createWriteStream(destPath);
  await streamPipeline(Readable.fromWeb(response.body as never), fileStream);
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
  private modelPath = "";

  constructor(model: string = DEFAULT_MODEL, numWorkers: number = DEFAULT_WORKERS) {
    this.model = model;
    this.numWorkers = numWorkers;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const modelDir = join(CACHE_DIR, this.model.replace(/\//g, "--"));
    await mkdir(modelDir, { recursive: true });

    // Resolve ONNX runtime (native C++ or WASM fallback)
    const { ort, label } = await resolveOnnxRuntime();
    this.ort = ort;
    this.runtimeLabel = label;

    // Download ONNX model if not cached
    this.modelPath = join(modelDir, "model.onnx");
    const modelPath = this.modelPath;
    if (!existsSync(modelPath)) {
      const onnxSubpath = ONNX_MODEL_PATHS[this.model] ?? "onnx/model.onnx";
      const url = `https://huggingface.co/${this.model}/resolve/main/${onnxSubpath}`;
      process.stderr.write(`Downloading ONNX model: ${this.model}...\n`);
      await downloadFile(url, modelPath);
      process.stderr.write(`Model downloaded to ${modelDir}\n`);
    }

    // Load tokenizer (uses HF transformers tokenizer infrastructure)
    this.tokenizer = await AutoTokenizer.from_pretrained(this.model, {
      cache_dir: CACHE_DIR,
    });

    // Create ONNX inference session
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: [label === "native" ? "cpu" : "wasm"],
    });

    // Determine dimensions from a test embedding
    const test = await this.embed("test");
    this.dimensions = test.length;
    this.initialized = true;

    process.stderr.write(`Embedder ready (${label} runtime, ${this.dimensions}d)\n`);
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

  async embedBatch(
    texts: string[],
    onProgress?: (embedded: number, total: number) => void
  ): Promise<Float32Array[]> {
    // Use workers for large batches (overhead isn't worth it for small ones)
    if (this.numWorkers > 1 && texts.length >= this.numWorkers * 2) {
      return this.embedBatchParallel(texts, onProgress);
    }
    // Serial fallback
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      results.push(await this.embed(texts[i]));
      onProgress?.(i + 1, texts.length);
    }
    return results;
  }

  private async embedBatchParallel(
    texts: string[],
    onProgress?: (embedded: number, total: number) => void
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
      // Fallback to serial if worker script not found
      process.stderr.write("Worker script not found, falling back to serial embedding\n");
      const results: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        results.push(await this.embed(texts[i]));
        onProgress?.(i + 1, texts.length);
      }
      return results;
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
