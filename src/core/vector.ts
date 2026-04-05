import hnswlib from "hnswlib-node";
const { HierarchicalNSW } = hnswlib;
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { SearchResult } from "./types.js";

interface ChunkMeta {
  docPath: string;
  chunkIndex: number;
  text: string;
}

export class VectorIndex {
  private index: InstanceType<typeof HierarchicalNSW> | null = null;
  private dimensions: number;
  private chunkMeta: ChunkMeta[] = [];

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  build(
    embeddings: Float32Array[],
    meta: ChunkMeta[]
  ): void {
    if (embeddings.length === 0) {
      this.index = null;
      this.chunkMeta = [];
      return;
    }

    this.index = new HierarchicalNSW("cosine", this.dimensions);
    this.index.initIndex(embeddings.length);

    for (let i = 0; i < embeddings.length; i++) {
      this.index.addPoint(Array.from(embeddings[i]), i);
    }

    this.chunkMeta = meta;
  }

  search(queryEmbedding: Float32Array, k: number = 10): SearchResult[] {
    if (!this.index || this.chunkMeta.length === 0) return [];

    const numResults = Math.min(k, this.chunkMeta.length);
    const result = this.index.searchKnn(Array.from(queryEmbedding), numResults);

    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (let i = 0; i < result.neighbors.length; i++) {
      const idx = result.neighbors[i];
      const meta = this.chunkMeta[idx];
      if (!meta || seen.has(meta.docPath)) continue;
      seen.add(meta.docPath);

      results.push({
        path: meta.docPath,
        title: meta.docPath,
        score: 1 - result.distances[i],
        snippet: meta.text.slice(0, 200),
        matchedChunk: meta.text,
      });
    }

    return results;
  }

  async save(indexPath: string): Promise<void> {
    if (!this.index) return;

    this.index.writeIndexSync(join(indexPath, "hnsw.bin"));
    await writeFile(
      join(indexPath, "hnsw-meta.json"),
      JSON.stringify(this.chunkMeta)
    );
  }

  async load(indexPath: string): Promise<boolean> {
    const hnswPath = join(indexPath, "hnsw.bin");
    const metaPath = join(indexPath, "hnsw-meta.json");

    if (!existsSync(hnswPath) || !existsSync(metaPath)) return false;

    const raw = await readFile(metaPath, "utf-8");
    this.chunkMeta = JSON.parse(raw);

    this.index = new HierarchicalNSW("cosine", this.dimensions);
    this.index.initIndex(this.chunkMeta.length);
    this.index.readIndexSync(hnswPath);

    return true;
  }

  getChunkMeta(): ChunkMeta[] {
    return this.chunkMeta;
  }
}
