import { describe, it, expect, beforeAll } from "vitest";
import { Embedder } from "../../src/core/embedder.js";

describe("Embedder", () => {
  let embedder: Embedder;

  beforeAll(async () => {
    embedder = new Embedder();
    await embedder.init();
  }, 120_000); // model download can take a while

  it("should initialize and report dimensions", () => {
    expect(embedder.getDimensions()).toBeGreaterThan(0);
  });

  it("should embed a string to a Float32Array", async () => {
    const vec = await embedder.embed("test query about microservices");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(embedder.getDimensions());
  });

  it("should produce normalized vectors", async () => {
    const vec = await embedder.embed("normalized vector test");
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 1);
  });

  it("should produce different embeddings for different text", async () => {
    const vec1 = await embedder.embed("kubernetes deployment strategy");
    const vec2 = await embedder.embed("chocolate cake recipe");
    // Cosine similarity should be low
    let dot = 0;
    for (let i = 0; i < vec1.length; i++) dot += vec1[i] * vec2[i];
    expect(dot).toBeLessThan(0.8);
  });

  it("should produce similar embeddings for similar text", async () => {
    const vec1 = await embedder.embed("microservices architecture patterns");
    const vec2 = await embedder.embed("distributed service design patterns");
    let dot = 0;
    for (let i = 0; i < vec1.length; i++) dot += vec1[i] * vec2[i];
    expect(dot).toBeGreaterThan(0.3);
  });

  it("should batch embed multiple texts", async () => {
    const vecs = await embedder.embedBatch(["hello", "world", "test"]);
    expect(vecs.length).toBe(3);
    for (const vec of vecs) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(embedder.getDimensions());
    }
  });

  it("should save and load embeddings", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "sp-embed-"));
    const map = new Map<string, Float32Array>();
    map.set("doc1:0", await embedder.embed("first chunk"));
    map.set("doc2:0", await embedder.embed("second chunk"));

    await embedder.saveEmbeddings(map, dir);
    const loaded = await embedder.loadEmbeddings(dir);

    expect(loaded.size).toBe(2);
    expect(loaded.has("doc1:0")).toBe(true);
    expect(loaded.get("doc1:0")!.length).toBe(embedder.getDimensions());

    await rm(dir, { recursive: true, force: true });
  });
});
