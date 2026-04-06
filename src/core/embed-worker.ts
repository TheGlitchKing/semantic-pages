import { parentPort, workerData } from "node:worker_threads";
import { AutoTokenizer } from "@huggingface/transformers";

interface WorkerData {
  modelPath: string;
  modelName: string;
  cacheDir: string;
  runtimeLabel: "native" | "wasm";
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

const { modelPath, modelName, cacheDir, runtimeLabel } = workerData as WorkerData;

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

      for (let i = 0; i < msg.texts.length; i++) {
        const encoded = await tokenizer(msg.texts[i], {
          padding: true,
          truncation: true,
          max_length: 512,
          return_tensor: false,
        });

        const inputIdsRaw: number[] = Array.from(encoded.input_ids.data ?? encoded.input_ids);
        const attentionMaskRaw: number[] = Array.from(encoded.attention_mask.data ?? encoded.attention_mask);
        const seqLen = inputIdsRaw.length;

        const inputIds = new ort.Tensor("int64", BigInt64Array.from(inputIdsRaw.map(BigInt)), [1, seqLen]);
        const attentionMask = new ort.Tensor("int64", BigInt64Array.from(attentionMaskRaw.map(BigInt)), [1, seqLen]);

        const feeds: Record<string, any> = { input_ids: inputIds, attention_mask: attentionMask };
        if (needsTokenTypeIds) {
          feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seqLen), [1, seqLen]);
        }

        const output = await session.run(feeds);
        const outputTensor = output[outputName];
        const hiddenSize = outputTensor.dims[outputTensor.dims.length - 1];

        // Mean pooling + L2 normalize
        const result = new Float32Array(hiddenSize);
        let maskSum = 0;
        for (let t = 0; t < seqLen; t++) {
          const mask = attentionMaskRaw[t];
          maskSum += mask;
          const offset = t * hiddenSize;
          for (let d = 0; d < hiddenSize; d++) {
            result[d] += (outputTensor.data as Float32Array)[offset + d] * mask;
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

        embeddings.push(result);

        parentPort!.postMessage({
          type: "progress",
          done: i + 1,
          total: msg.texts.length,
          startIndex: msg.startIndex,
        } as ProgressMessage);
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
