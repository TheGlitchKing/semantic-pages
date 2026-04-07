import Graph from "graphology";
import { bfsFromNode } from "graphology-traversal";
import { bidirectional } from "graphology-shortest-path";
import type { IndexedDocument, GraphNode, GraphEdge, GraphStats } from "./types.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

export class GraphBuilder {
  private graph: Graph;

  constructor() {
    this.graph = new Graph({ type: "directed", multi: false });
  }

  buildFromDocuments(documents: IndexedDocument[]): void {
    this.graph.clear();

    // Add nodes
    for (const doc of documents) {
      this.graph.addNode(doc.path, {
        title: doc.title,
        tags: doc.tags,
      });
    }

    const pathLookup = new Map<string, string>();
    for (const doc of documents) {
      const nameNoExt = doc.path.replace(/\.md$/, "");
      const basename = nameNoExt.split("/").pop()!;
      pathLookup.set(basename.toLowerCase(), doc.path);
      pathLookup.set(nameNoExt.toLowerCase(), doc.path);
    }

    // Add wikilink edges
    for (const doc of documents) {
      for (const link of doc.wikilinks) {
        const target = pathLookup.get(link.toLowerCase());
        if (target && target !== doc.path && !this.graph.hasEdge(doc.path, target)) {
          this.graph.addEdge(doc.path, target, { type: "wikilink", weight: 1.0 });
        }
      }
    }

    // Add tag-based edges
    const tagToNotes = new Map<string, string[]>();
    for (const doc of documents) {
      for (const tag of doc.tags) {
        const notes = tagToNotes.get(tag) || [];
        notes.push(doc.path);
        tagToNotes.set(tag, notes);
      }
    }

    for (const [, notes] of tagToNotes) {
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

  searchGraph(concept: string, maxDepth = 2): GraphNode[] {
    const startNodes = this.graph
      .nodes()
      .filter((n) => {
        const attrs = this.graph.getNodeAttributes(n);
        const title = typeof attrs.title === "string" ? attrs.title : String(attrs.title ?? "");
        return (
          n.toLowerCase().includes(concept.toLowerCase()) ||
          title.toLowerCase().includes(concept.toLowerCase()) ||
          attrs.tags?.some((t: string) => t.toLowerCase().includes(concept.toLowerCase()))
        );
      });

    const visited = new Set<string>();
    for (const start of startNodes) {
      let depth = 0;
      bfsFromNode(this.graph, start, (node) => {
        visited.add(node);
        depth++;
        return depth > maxDepth;
      });
    }

    return [...visited].map((n) => this.nodeToGraphNode(n));
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
      title: attrs.title || nodePath,
      tags: attrs.tags || [],
      linkCount: this.graph.outDegree(nodePath),
      backlinkCount: this.graph.inDegree(nodePath),
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
