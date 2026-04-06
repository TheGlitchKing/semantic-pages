import { parentPort, workerData } from "node:worker_threads";
import { AutoTokenizer } from "@huggingface/transformers";

interface WorkerData {
  modelPath: string;
  modelName: string;
  cacheDir: string;
  runtimeLabel: "native" | "wasm";
  batchSize: number;
}

interface WorkMessage {
  type: "embed";
  texts: string[];
  startIndex: number;
}

interface ResultMessage {
  type: "result";
  embeddings: Float32Array[];
  startIndex: number;
}

interface ProgressMessage {
  type: "progress";
  done: number;
  total: number;
  startIndex: number;
}

interface ErrorMessage {
  type: "error";
  error: string;
}

interface ReadyMessage {
  type: "ready";
}

const { modelPath, modelName, cacheDir, runtimeLabel, batchSize = 32 } = workerData as WorkerData;

function meanPoolAndNormalizeMany(
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
        result[d] += (outputData as Float32Array)[offset + d] * mask;
      }
    }
    if (maskSum > 0) {
      for (let d = 0; d < hiddenSize; d++) result[d] /= maskSum;
    }
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

async function init() {
  // Resolve ONNX runtime
  let ort: any;
  try {
    if (runtimeLabel === "native") {
      ort = await import("onnxruntime-node");
    } else {
      ort = await import("onnxruntime-web");
    }
  } catch {
    ort = await import("onnxruntime-web");
  }

  // Load tokenizer and session
  const tokenizer = await AutoTokenizer.from_pretrained(modelName, { cache_dir: cacheDir });
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: [runtimeLabel === "native" ? "cpu" : "wasm"],
  });

  const needsTokenTypeIds = session.inputNames.includes("token_type_ids");
  const outputName = session.outputNames[0];

  parentPort!.postMessage({ type: "ready" } as ReadyMessage);

  parentPort!.on("message", async (msg: WorkMessage) => {
    if (msg.type !== "embed") return;

    try {
      const embeddings: Float32Array[] = [];
      let totalDone = 0;

      // Process texts in sub-batches
      for (let i = 0; i < msg.texts.length; i += batchSize) {
        const subBatch = msg.texts.slice(i, i + batchSize);
        const n = subBatch.length;

        // Tokenize individually to avoid ambiguous batch tokenizer output format
        const encodings = await Promise.all(
          subBatch.map((text: string) =>
            tokenizer(text, { padding: false, truncation: true, max_length: 512, return_tensor: false })
          )
        );
        const tokenized = encodings.map((enc: any) => ({
          ids: Array.from(enc.input_ids.data ?? enc.input_ids) as number[],
          mask: Array.from(enc.attention_mask.data ?? enc.attention_mask) as number[],
        }));
        const seqLen = Math.max(...tokenized.map((t: any) => t.ids.length));

        const flatIds = new BigInt64Array(n * seqLen);
        const flatMask = new BigInt64Array(n * seqLen);
        const flatMaskNums = new Array<number>(n * seqLen).fill(0);
        for (let b = 0; b < n; b++) {
          const { ids, mask } = tokenized[b];
          for (let j = 0; j < ids.length; j++) {
            flatIds[b * seqLen + j] = BigInt(ids[j]);
            flatMask[b * seqLen + j] = BigInt(mask[j]);
            flatMaskNums[b * seqLen + j] = mask[j];
          }
        }

        const inputIds = new ort.Tensor("int64", flatIds, [n, seqLen]);
        const attentionMask = new ort.Tensor("int64", flatMask, [n, seqLen]);

        const feeds: Record<string, any> = { input_ids: inputIds, attention_mask: attentionMask };
        if (needsTokenTypeIds) {
          feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(n * seqLen), [n, seqLen]);
        }

        const output = await session.run(feeds);
        const outputTensor = output[outputName];
        const hiddenSize = outputTensor.dims[outputTensor.dims.length - 1];

        const batchEmbeddings = meanPoolAndNormalizeMany(
          outputTensor.data as Float32Array,
          flatMaskNums,
          n,
          seqLen,
          hiddenSize
        );

        for (const emb of batchEmbeddings) {
          embeddings.push(emb);
          totalDone++;
          parentPort!.postMessage({
            type: "progress",
            done: totalDone,
            total: msg.texts.length,
            startIndex: msg.startIndex,
          } as ProgressMessage);
        }
      }

      parentPort!.postMessage({
        type: "result",
        embeddings,
        startIndex: msg.startIndex,
      } as ResultMessage);
    } catch (err: any) {
      parentPort!.postMessage({
        type: "error",
        error: err?.message ?? String(err),
      } as ErrorMessage);
    }
  });
}

init().catch((err) => {
  parentPort!.postMessage({ type: "error", error: err?.message ?? String(err) } as ErrorMessage);
});
