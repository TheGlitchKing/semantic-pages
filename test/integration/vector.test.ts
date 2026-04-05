import { describe, it, expect, beforeAll } from "vitest";
import { Embedder } from "../../src/core/embedder.js";
import { VectorIndex } from "../../src/core/vector.js";

describe("VectorIndex", () => {
  let embedder: Embedder;
  let index: VectorIndex;

  const docs = [
    { path: "arch.md", text: "microservices architecture with event-driven communication" },
    { path: "deploy.md", text: "kubernetes deployment with docker containers and CI/CD pipelines" },
    { path: "auth.md", text: "OAuth2 authentication with JWT tokens and role-based access" },
    { path: "db.md", text: "PostgreSQL database schema design and migrations" },
    { path: "frontend.md", text: "React components with TypeScript and state management" },
  ];

  beforeAll(async () => {
    embedder = new Embedder();
    await embedder.init();

    const embeddings: Float32Array[] = [];
    const meta: Array<{ docPath: string; chunkIndex: number; text: string }> = [];

    for (const doc of docs) {
      const vec = await embedder.embed(doc.text);
      embeddings.push(vec);
      meta.push({ docPath: doc.path, chunkIndex: 0, text: doc.text });
    }

    index = new VectorIndex(embedder.getDimensions());
    index.build(embeddings, meta);
  }, 120_000);

  it("should return relevant results for a query", async () => {
    const queryVec = await embedder.embed("service architecture");
    const results = index.search(queryVec, 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("arch.md");
  });

  it("should return results sorted by score (descending)", async () => {
    const queryVec = await embedder.embed("container deployment");
    const results = index.search(queryVec, 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it("should respect the k limit", async () => {
    const queryVec = await embedder.embed("something");
    const results = index.search(queryVec, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should deduplicate by document path", async () => {
    const queryVec = await embedder.embed("test");
    const results = index.search(queryVec, 10);
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("should include snippets in results", async () => {
    const queryVec = await embedder.embed("authentication");
    const results = index.search(queryVec, 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("should handle empty index gracefully", () => {
    const emptyIndex = new VectorIndex(embedder.getDimensions());
    emptyIndex.build([], []);
    const queryVec = new Float32Array(embedder.getDimensions());
    const results = emptyIndex.search(queryVec, 5);
    expect(results).toEqual([]);
  });

  it("should save and load from disk", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "sp-vec-"));
    await index.save(dir);

    const loaded = new VectorIndex(embedder.getDimensions());
    const success = await loaded.load(dir);
    expect(success).toBe(true);

    // Loaded index should return same results
    const queryVec = await embedder.embed("service architecture");
    const origResults = index.search(queryVec, 3);
    const loadedResults = loaded.search(queryVec, 3);
    expect(loadedResults[0].path).toBe(origResults[0].path);

    await rm(dir, { recursive: true, force: true });
  });
});
