import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5";
const CACHE_DIR = join(homedir(), ".semantic-pages", "models");

export class Embedder {
  private model: string;
  private extractor: FeatureExtractionPipeline | null = null;
  private dimensions = 0;

  constructor(model: string = DEFAULT_MODEL) {
    this.model = model;
  }

  async init(): Promise<void> {
    if (this.extractor) return;

    await mkdir(CACHE_DIR, { recursive: true });

    this.extractor = await pipeline("feature-extraction", this.model, {
      cache_dir: CACHE_DIR,
      dtype: "fp32",
    });

    // Determine dimensions from a test embedding
    const test = await this.embed("test");
    this.dimensions = test.length;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error("Embedder not initialized. Call init() first.");

    const output = await this.extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data as ArrayLike<number>);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getModel(): string {
    return this.model;
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
