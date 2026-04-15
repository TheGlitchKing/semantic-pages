// Vitest globalSetup: ensure the ONNX model is downloaded ONCE before any
// test files run. Without this, parallel test files (embedder.test.ts,
// vector.test.ts, mcp-server.test.ts, stdio-server.test.ts, new-features,
// lazy-startup) each call Embedder.init() simultaneously and race on the
// model download. The atomic-rename fix in src/core/embedder.ts prevents
// corruption, but doing the download N times in parallel still wastes
// bandwidth and slows the suite. This pre-warms the cache so every test
// that follows hits an existsSync() == true and skips the download.
import { Embedder } from "../src/core/embedder.js";

export default async function setup(): Promise<void> {
  const embedder = new Embedder();
  // init() downloads the model and creates an ONNX session. We don't need the
  // session here, just the side effect of materializing the model file.
  await embedder.init();
}
