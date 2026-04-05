import type { IndexedDocument, SearchResult, SearchTextOptions } from "./types.js";
import { minimatch } from "minimatch";

export class TextSearch {
  private documents: IndexedDocument[] = [];

  setDocuments(documents: IndexedDocument[]): void {
    this.documents = documents;
  }

  search(options: SearchTextOptions): SearchResult[] {
    const { pattern, regex, caseSensitive, pathGlob, tagFilter, limit = 20 } = options;

    let matcher: (text: string) => { matched: boolean; index: number };

    if (regex) {
      const flags = caseSensitive ? "g" : "gi";
      const re = new RegExp(pattern, flags);
      matcher = (text) => {
        re.lastIndex = 0;
        const m = re.exec(text);
        return { matched: !!m, index: m?.index ?? -1 };
      };
    } else {
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (text) => {
        const haystack = caseSensitive ? text : text.toLowerCase();
        const idx = haystack.indexOf(needle);
        return { matched: idx >= 0, index: idx };
      };
    }

    const results: SearchResult[] = [];

    for (const doc of this.documents) {
      // Path filter
      if (pathGlob && !minimatch(doc.path, pathGlob)) continue;

      // Tag filter
      if (tagFilter?.length) {
        const hasTag = tagFilter.some((t) => doc.tags.includes(t));
        if (!hasTag) continue;
      }

      const { matched, index } = matcher(doc.content);
      if (!matched) continue;

      const snippetStart = Math.max(0, index - 80);
      const snippetEnd = Math.min(doc.content.length, index + 120);
      const snippet = doc.content.slice(snippetStart, snippetEnd).trim();

      results.push({
        path: doc.path,
        title: doc.title,
        score: 1.0,
        snippet: (snippetStart > 0 ? "..." : "") + snippet + (snippetEnd < doc.content.length ? "..." : ""),
      });

      if (results.length >= limit) break;
    }

    return results;
  }
}
