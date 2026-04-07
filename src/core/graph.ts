import Graph from "graphology";
import { bfsFromNode } from "graphology-traversal";
import { bidirectional } from "graphology-shortest-path";
import type { IndexedDocument, GraphNode, GraphEdge, GraphStats } from "./types.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Tags shared by more than this many docs are too generic to be meaningful
 * graph edges (e.g. "api", "testing"). Only specific/rare tags create edges.
 * Docs without frontmatter are unaffected — their inline #tags still participate
 * but only if those tags are specific enough to pass this threshold.
 */
const TAG_EDGE_MAX_DOCS = 15;

export class GraphBuilder {
  private graph: Graph;

  constructor() {
    this.graph = new Graph({ type: "directed", multi: false });
  }

  buildFromDocuments(documents: IndexedDocument[]): void {
    this.graph.clear();

    // Add nodes — store optional metadata fields when present
    for (const doc of documents) {
      this.graph.addNode(doc.path, {
        title: doc.title,
        tags: doc.tags,
        ...(doc.status !== undefined && { status: doc.status }),
        ...(doc.loadPriority !== undefined && { loadPriority: doc.loadPriority }),
      });
    }

    const pathLookup = new Map<string, string>();
    for (const doc of documents) {
      const nameNoExt = doc.path.replace(/\.md$/, "");
      const basename = nameNoExt.split("/").pop()!;
      pathLookup.set(basename.toLowerCase(), doc.path);
      pathLookup.set(nameNoExt.toLowerCase(), doc.path);
    }

    // Add wikilink edges (weight 1.0)
    for (const doc of documents) {
      for (const link of doc.wikilinks) {
        const target = pathLookup.get(link.toLowerCase());
        if (target && target !== doc.path && !this.graph.hasEdge(doc.path, target)) {
          this.graph.addEdge(doc.path, target, { type: "wikilink", weight: 1.0 });
        }
      }
    }

    // Add related_docs edges (weight 1.0) — only present when frontmatter has related_docs
    // Falls back gracefully: docs without this field are simply skipped
    for (const doc of documents) {
      if (!doc.relatedDocs?.length) continue;
      for (const ref of doc.relatedDocs) {
        // Try full normalized path first, then basename — same strategy as wikilinks
        const normalized = ref.replace(/\.md$/, "").toLowerCase();
        const base = normalized.split("/").pop()!;
        const target = pathLookup.get(normalized) ?? pathLookup.get(base);
        if (target && target !== doc.path && !this.graph.hasEdge(doc.path, target)) {
          this.graph.addEdge(doc.path, target, { type: "related", weight: 1.0 });
        }
      }
    }

    // Add tag-based edges (weight 0.5) — capped at TAG_EDGE_MAX_DOCS per tag.
    // Generic tags shared by many docs (e.g. "api", "testing") create noise;
    // only specific tags (e.g. "qdrant", "celery") create meaningful connections.
    const tagToNotes = new Map<string, string[]>();
    for (const doc of documents) {
      for (const tag of doc.tags) {
        const notes = tagToNotes.get(tag) ?? [];
        notes.push(doc.path);
        tagToNotes.set(tag, notes);
      }
    }

    for (const [, notes] of tagToNotes) {
      if (notes.length >= TAG_EDGE_MAX_DOCS) continue; // too generic — skip
      for (let i = 0; i < notes.length; i++) {
        for (let j = i + 1; j < notes.length; j++) {
          if (!this.graph.hasEdge(notes[i], notes[j])) {
            this.graph.addEdge(notes[i], notes[j], { type: "tag", weight: 0.5 });
          }
          if (!this.graph.hasEdge(notes[j], notes[i])) {
            this.graph.addEdge(notes[j], notes[i], { type: "tag", weight: 0.5 });
          }
        }
      }
    }
  }

  backlinks(notePath: string): GraphNode[] {
    if (!this.graph.hasNode(notePath)) return [];
    return this.graph.inNeighbors(notePath).map((n) => this.nodeToGraphNode(n));
  }

  forwardlinks(notePath: string): GraphNode[] {
    if (!this.graph.hasNode(notePath)) return [];
    return this.graph.outNeighbors(notePath).map((n) => this.nodeToGraphNode(n));
  }

  findPath(from: string, to: string): string[] | null {
    if (!this.graph.hasNode(from) || !this.graph.hasNode(to)) return null;
    const path = bidirectional(this.graph, from, to);
    return path;
  }

  searchGraph(concept: string, maxDepth = 2, limit = 20): GraphNode[] {
    const lc = concept.toLowerCase();

    const directMatches = new Set<string>(
      this.graph.nodes().filter((n) => {
        const attrs = this.graph.getNodeAttributes(n);
        const title = typeof attrs.title === "string" ? attrs.title : String(attrs.title ?? "");
        return (
          n.toLowerCase().includes(lc) ||
          title.toLowerCase().includes(lc) ||
          (attrs.tags as string[] | undefined)?.some((t) => t.toLowerCase().includes(lc))
        );
      })
    );

    const visited = new Set<string>();
    for (const start of directMatches) {
      bfsFromNode(this.graph, start, (_node, _attr, depth) => {
        if (visited.size >= limit * 3) return true; // gather 3x limit before ranking
        visited.add(_node);
        return depth >= maxDepth;
      });
    }

    // Sort: direct matches first, then by loadPriority desc, then by degree desc
    // deprecated/archived nodes sort to the end
    const ranked = [...visited].sort((a, b) => {
      const aAttrs = this.graph.getNodeAttributes(a);
      const bAttrs = this.graph.getNodeAttributes(b);
      const aDeprecated = aAttrs.status === "deprecated" || aAttrs.status === "archived" ? 1 : 0;
      const bDeprecated = bAttrs.status === "deprecated" || bAttrs.status === "archived" ? 1 : 0;
      if (aDeprecated !== bDeprecated) return aDeprecated - bDeprecated;
      const aDirect = directMatches.has(a) ? 0 : 1;
      const bDirect = directMatches.has(b) ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      const aPriority = (aAttrs.loadPriority as number | undefined) ?? 5;
      const bPriority = (bAttrs.loadPriority as number | undefined) ?? 5;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return this.graph.degree(b) - this.graph.degree(a);
    });

    return ranked.slice(0, limit).map((n) => this.nodeToGraphNode(n));
  }

  statistics(): GraphStats {
    const nodes = this.graph.order;
    const edges = this.graph.size;
    const orphans = this.graph.nodes().filter(
      (n) => this.graph.degree(n) === 0
    );

    const connections = this.graph.nodes().map((n) => ({
      path: n,
      connections: this.graph.degree(n),
    }));
    connections.sort((a, b) => b.connections - a.connections);

    const maxPossibleEdges = nodes * (nodes - 1);
    const density = maxPossibleEdges > 0 ? edges / maxPossibleEdges : 0;

    return {
      totalNodes: nodes,
      totalEdges: edges,
      orphanCount: orphans.length,
      mostConnected: connections.slice(0, 10),
      density,
    };
  }

  private nodeToGraphNode(nodePath: string): GraphNode {
    const attrs = this.graph.getNodeAttributes(nodePath);
    return {
      path: nodePath,
      title: typeof attrs.title === "string" ? attrs.title : nodePath,
      tags: (attrs.tags as string[]) || [],
      linkCount: this.graph.outDegree(nodePath),
      backlinkCount: this.graph.inDegree(nodePath),
      ...(attrs.loadPriority !== undefined && { loadPriority: attrs.loadPriority as number }),
      ...(attrs.status !== undefined && { status: attrs.status as string }),
    };
  }

  async save(indexPath: string): Promise<void> {
    const data = this.graph.export();
    await writeFile(join(indexPath, "graph.json"), JSON.stringify(data));
  }

  async load(indexPath: string): Promise<boolean> {
    const filePath = join(indexPath, "graph.json");
    if (!existsSync(filePath)) return false;

    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    this.graph.import(data);
    return true;
  }

  getGraph(): Graph {
    return this.graph;
  }
}
