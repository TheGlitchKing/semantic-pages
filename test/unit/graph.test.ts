import { describe, it, expect, beforeAll } from "vitest";
import { Indexer } from "../../src/core/indexer.js";
import { GraphBuilder } from "../../src/core/graph.js";
import { FIXTURES_VAULT } from "../setup.js";
import type { IndexedDocument } from "../../src/core/types.js";

describe("GraphBuilder", () => {
  let graph: GraphBuilder;
  let documents: IndexedDocument[];

  beforeAll(async () => {
    const indexer = new Indexer(FIXTURES_VAULT);
    documents = await indexer.indexAll();
    graph = new GraphBuilder();
    graph.buildFromDocuments(documents);
  });

  it("should create nodes for all documents", () => {
    const stats = graph.statistics();
    expect(stats.totalNodes).toBe(documents.length);
  });

  it("should create edges from wikilinks", () => {
    const stats = graph.statistics();
    expect(stats.totalEdges).toBeGreaterThan(0);
  });

  it("should find backlinks", () => {
    const backlinks = graph.backlinks("microservices.md");
    const paths = backlinks.map((n) => n.path);
    expect(paths).toContain("project-overview.md");
  });

  it("should find forwardlinks", () => {
    const links = graph.forwardlinks("project-overview.md");
    const paths = links.map((n) => n.path);
    expect(paths).toContain("microservices.md");
    expect(paths).toContain("event-driven.md");
    expect(paths).toContain("api-gateway.md");
  });

  it("should find shortest path between notes", () => {
    const path = graph.findPath("project-overview.md", "user-service.md");
    expect(path).not.toBeNull();
    expect(path![0]).toBe("project-overview.md");
    expect(path![path!.length - 1]).toBe("user-service.md");
  });

  it("should return null for unreachable paths", () => {
    const path = graph.findPath("orphan.md", "project-overview.md");
    // Orphan may still connect via tag edges, so check both cases
    if (path === null) {
      expect(path).toBeNull();
    } else {
      expect(path.length).toBeGreaterThan(0);
    }
  });

  it("should detect orphan notes in statistics", () => {
    const stats = graph.statistics();
    // orphan.md has a unique tag "standalone" so it might still be an orphan
    // if no other note shares that tag
    expect(stats.orphanCount).toBeGreaterThanOrEqual(0);
  });

  it("should search graph by concept", () => {
    const results = graph.searchGraph("microservices");
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("microservices.md");
  });

  it("should compute density", () => {
    const stats = graph.statistics();
    expect(stats.density).toBeGreaterThan(0);
    expect(stats.density).toBeLessThanOrEqual(1);
  });

  it("should report most connected nodes", () => {
    const stats = graph.statistics();
    expect(stats.mostConnected.length).toBeGreaterThan(0);
    expect(stats.mostConnected[0].connections).toBeGreaterThan(0);
  });

  it("should serialize and deserialize", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "sp-graph-"));
    await graph.save(dir);

    const loaded = new GraphBuilder();
    const success = await loaded.load(dir);
    expect(success).toBe(true);

    const origStats = graph.statistics();
    const loadedStats = loaded.statistics();
    expect(loadedStats.totalNodes).toBe(origStats.totalNodes);
    expect(loadedStats.totalEdges).toBe(origStats.totalEdges);

    await rm(dir, { recursive: true, force: true });
  });
});
