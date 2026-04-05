#!/usr/bin/env node

import { program } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

program
  .name("semantic-pages")
  .description("Semantic search + knowledge graph MCP server for markdown files")
  .version("0.1.0")
  .requiredOption("--notes <path>", "Path to markdown notes directory")
  .option("--reindex", "Force full reindex and exit")
  .option("--stats", "Show vault statistics and exit")
  .option("--model <name>", "Embedding model to use", "nomic-ai/nomic-embed-text-v1.5")
  .option("--no-watch", "Disable file watcher");

program.parse();

const opts = program.opts();
const notesPath = resolve(opts.notes);

if (!existsSync(notesPath)) {
  console.error(`Error: notes directory not found: ${notesPath}`);
  process.exit(1);
}

async function main() {
  if (opts.stats) {
    const { Indexer } = await import("../core/indexer.js");
    const indexer = new Indexer(notesPath);
    const docs = await indexer.indexAll();
    console.log(`Notes: ${docs.length}`);
    console.log(`Chunks: ${docs.reduce((n, d) => n + d.chunks.length, 0)}`);
    console.log(`Wikilinks: ${docs.reduce((n, d) => n + d.wikilinks.length, 0)}`);
    console.log(`Tags: ${new Set(docs.flatMap((d) => d.tags)).size} unique`);
    process.exit(0);
  }

  if (opts.reindex) {
    const { createServer } = await import("../mcp/server.js");
    await createServer(notesPath, { watch: false });
    console.log("Reindex complete.");
    process.exit(0);
  }

  // Default: start MCP server on stdio
  const { startServer } = await import("../mcp/server.js");
  await startServer(notesPath, { watch: opts.watch });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
