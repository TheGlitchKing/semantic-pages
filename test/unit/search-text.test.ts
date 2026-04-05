import { describe, it, expect, beforeAll } from "vitest";
import { Indexer } from "../../src/core/indexer.js";
import { TextSearch } from "../../src/core/search-text.js";
import { FIXTURES_VAULT } from "../setup.js";

describe("TextSearch", () => {
  let textSearch: TextSearch;

  beforeAll(async () => {
    const indexer = new Indexer(FIXTURES_VAULT);
    const docs = await indexer.indexAll();
    textSearch = new TextSearch();
    textSearch.setDocuments(docs);
  });

  it("should find keyword matches", () => {
    const results = textSearch.search({ pattern: "microservices" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "microservices.md")).toBe(true);
  });

  it("should be case-insensitive by default", () => {
    const results = textSearch.search({ pattern: "MICROSERVICES" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("should support case-sensitive search", () => {
    const results = textSearch.search({
      pattern: "MICROSERVICES",
      caseSensitive: true,
    });
    expect(results.length).toBe(0);
  });

  it("should support regex search", () => {
    const results = textSearch.search({
      pattern: "OAuth\\d",
      regex: true,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "user-service.md")).toBe(true);
  });

  it("should filter by path glob", () => {
    const results = textSearch.search({
      pattern: "microservices",
      pathGlob: "notes/**",
    });
    // Only the meeting note in notes/ should match
    for (const r of results) {
      expect(r.path.startsWith("notes/")).toBe(true);
    }
  });

  it("should filter by tags", () => {
    const results = textSearch.search({
      pattern: "service",
      tagFilter: ["devops"],
    });
    // Only deployment-guide has devops tag
    for (const r of results) {
      expect(r.path).toBe("deployment-guide.md");
    }
  });

  it("should respect limit", () => {
    const results = textSearch.search({ pattern: "the", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should return empty for no matches", () => {
    const results = textSearch.search({ pattern: "zzzznonexistent" });
    expect(results).toEqual([]);
  });

  it("should include snippets", () => {
    const results = textSearch.search({ pattern: "RabbitMQ" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("RabbitMQ");
  });
});
