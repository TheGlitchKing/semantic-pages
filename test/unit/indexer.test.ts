import { describe, it, expect, beforeAll } from "vitest";
import { Indexer } from "../../src/core/indexer.js";
import { FIXTURES_VAULT } from "../setup.js";
import type { IndexedDocument } from "../../src/core/types.js";

describe("Indexer", () => {
  let indexer: Indexer;
  let documents: IndexedDocument[];

  beforeAll(async () => {
    indexer = new Indexer(FIXTURES_VAULT);
    documents = await indexer.indexAll();
  });

  it("should find all markdown files including nested", () => {
    expect(documents.length).toBeGreaterThanOrEqual(9);
    const paths = documents.map((d) => d.path);
    expect(paths).toContain("project-overview.md");
    expect(paths).toContain("microservices.md");
    expect(paths.some((p) => p.includes("meeting-2024-01-15.md"))).toBe(true);
  });

  it("should parse frontmatter correctly", () => {
    const overview = documents.find((d) => d.path === "project-overview.md")!;
    expect(overview.frontmatter.title).toBe("Project Overview");
    expect(overview.frontmatter.tags).toEqual(["project", "overview"]);
  });

  it("should extract title from frontmatter", () => {
    const overview = documents.find((d) => d.path === "project-overview.md")!;
    expect(overview.title).toBe("Project Overview");
  });

  it("should fall back to heading for title when no frontmatter title", () => {
    const noFm = documents.find((d) => d.path === "no-frontmatter.md")!;
    expect(noFm.title).toBe("Simple Note");
  });

  it("should extract wikilinks", () => {
    const overview = documents.find((d) => d.path === "project-overview.md")!;
    expect(overview.wikilinks).toContain("microservices");
    expect(overview.wikilinks).toContain("event-driven");
    expect(overview.wikilinks).toContain("api-gateway");
  });

  it("should extract tags from both frontmatter and inline", () => {
    const overview = documents.find((d) => d.path === "project-overview.md")!;
    expect(overview.tags).toContain("project");
    expect(overview.tags).toContain("overview");
    expect(overview.tags).toContain("architecture");
    expect(overview.tags).toContain("goals");
  });

  it("should extract headers", () => {
    const overview = documents.find((d) => d.path === "project-overview.md")!;
    expect(overview.headers).toContain("Project Overview");
    expect(overview.headers).toContain("Architecture");
    expect(overview.headers).toContain("Goals");
  });

  it("should produce chunks", () => {
    const micro = documents.find((d) => d.path === "microservices.md")!;
    expect(micro.chunks.length).toBeGreaterThanOrEqual(1);
    expect(micro.chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("should handle empty files", () => {
    const empty = documents.find((d) => d.path === "empty-note.md")!;
    expect(empty).toBeDefined();
    expect(empty.wikilinks).toEqual([]);
    expect(empty.tags).toEqual([]);
  });

  it("should handle files with no frontmatter", () => {
    const noFm = documents.find((d) => d.path === "no-frontmatter.md")!;
    expect(noFm).toBeDefined();
    expect(noFm.frontmatter).toEqual({});
    expect(noFm.wikilinks).toContain("project-overview");
    expect(noFm.tags).toContain("simple-tag");
  });

  describe("chunkText", () => {
    it("should return single chunk for short text", () => {
      const chunks = indexer.chunkText("Short text.");
      expect(chunks).toEqual(["Short text."]);
    });

    it("should split long text at sentence boundaries", () => {
      const longText = Array(50).fill("This is a sentence that adds length to the text.").join(" ");
      const chunks = indexer.chunkText(longText);
      expect(chunks.length).toBeGreaterThan(1);
      // No chunk should drastically exceed target
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThan(4000);
      }
    });
  });
});
