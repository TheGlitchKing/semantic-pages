export interface IndexedDocument {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  wikilinks: string[];
  tags: string[];
  headers: string[];
  chunks: string[];
}

export interface SearchResult {
  path: string;
  title: string;
  score: number;
  snippet: string;
  matchedChunk?: string;
}

export interface GraphNode {
  path: string;
  title: string;
  tags: string[];
  linkCount: number;
  backlinkCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: "wikilink" | "tag" | "backlink";
  weight: number;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  orphanCount: number;
  mostConnected: Array<{ path: string; connections: number }>;
  density: number;
}

export type IndexState = "empty" | "loading" | "stale" | "indexing" | "ready";

export interface IndexProgress {
  state: IndexState;
  embedded?: number;
  total?: number;
}

export interface VaultStats {
  totalNotes: number;
  totalChunks: number;
  totalEmbeddings: number;
  embeddingDimensions: number;
  embeddingModel: string;
  graphNodes: number;
  graphEdges: number;
  indexSize: number;
  lastIndexed: string | null;
  indexState: IndexState;
  indexProgress?: { embedded: number; total: number };
}

export interface UpdateNoteOptions {
  mode: "overwrite" | "append" | "prepend" | "patch-by-heading";
  heading?: string;
}

export interface SearchTextOptions {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  pathGlob?: string;
  tagFilter?: string[];
  limit?: number;
}
