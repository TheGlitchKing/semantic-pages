#!/usr/bin/env node

import { program } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const TOOL_HELP: Record<string, { description: string; args: string; examples: string[] }> = {
  // Search
  search_semantic: {
    description: "Vector similarity search — find notes by meaning, not just keywords",
    args: '{ "query": "string", "limit?": 10 }',
    examples: [
      '{ "query": "microservices architecture", "limit": 5 }',
      '{ "query": "how to deploy to production" }',
    ],
  },
  search_text: {
    description: "Full-text keyword or regex search with optional filters",
    args: '{ "pattern": "string", "regex?": false, "caseSensitive?": false, "pathGlob?": "string", "tagFilter?": ["string"], "limit?": 20 }',
    examples: [
      '{ "pattern": "RabbitMQ" }',
      '{ "pattern": "OAuth\\\\d", "regex": true }',
      '{ "pattern": "deploy", "pathGlob": "devops/**", "tagFilter": ["kubernetes"] }',
    ],
  },
  search_graph: {
    description: "Graph traversal — find notes connected to a concept via wikilinks and tags",
    args: '{ "concept": "string", "maxDepth?": 2 }',
    examples: [
      '{ "concept": "microservices" }',
      '{ "concept": "auth", "maxDepth": 3 }',
    ],
  },
  search_hybrid: {
    description: "Combined semantic + graph search — vector results re-ranked by graph proximity",
    args: '{ "query": "string", "limit?": 10 }',
    examples: [
      '{ "query": "event driven architecture", "limit": 5 }',
    ],
  },

  // Read
  read_note: {
    description: "Read the full content of a specific note by path",
    args: '{ "path": "string" }',
    examples: [
      '{ "path": "project-overview.md" }',
      '{ "path": "notes/meeting-2024-01-15.md" }',
    ],
  },
  read_multiple_notes: {
    description: "Batch read multiple notes in one call",
    args: '{ "paths": ["string"] }',
    examples: [
      '{ "paths": ["overview.md", "architecture.md", "deployment.md"] }',
    ],
  },
  list_notes: {
    description: "List all indexed notes with metadata (title, tags, link count)",
    args: "{}",
    examples: ["{}"],
  },

  // Write
  create_note: {
    description: "Create a new markdown note with optional YAML frontmatter",
    args: '{ "path": "string", "content": "string", "frontmatter?": {} }',
    examples: [
      '{ "path": "new-guide.md", "content": "# Guide\\n\\nContent here." }',
      '{ "path": "tagged.md", "content": "Content.", "frontmatter": { "title": "Tagged Note", "tags": ["test"] } }',
    ],
  },
  update_note: {
    description: "Edit note content — overwrite, append, prepend, or patch by heading",
    args: '{ "path": "string", "content": "string", "mode": "overwrite|append|prepend|patch-by-heading", "heading?": "string" }',
    examples: [
      '{ "path": "guide.md", "content": "New content.", "mode": "overwrite" }',
      '{ "path": "guide.md", "content": "\\n## Appendix\\nExtra info.", "mode": "append" }',
      '{ "path": "guide.md", "content": "Updated architecture section.", "mode": "patch-by-heading", "heading": "Architecture" }',
    ],
  },
  delete_note: {
    description: "Delete a note permanently (requires confirm=true)",
    args: '{ "path": "string", "confirm": true }',
    examples: [
      '{ "path": "old-note.md", "confirm": true }',
      '{ "path": "old-note.md", "confirm": false }  // returns warning, does not delete',
    ],
  },
  move_note: {
    description: "Move or rename a note — automatically updates wikilinks across the vault",
    args: '{ "from": "string", "to": "string" }',
    examples: [
      '{ "from": "user-service.md", "to": "auth-service.md" }',
      '{ "from": "old/note.md", "to": "new/location/note.md" }',
    ],
  },

  // Metadata
  get_frontmatter: {
    description: "Read parsed YAML frontmatter from a note as JSON",
    args: '{ "path": "string" }',
    examples: ['{ "path": "project-overview.md" }'],
  },
  update_frontmatter: {
    description: "Set or delete YAML frontmatter keys — pass null to delete a key",
    args: '{ "path": "string", "fields": {} }',
    examples: [
      '{ "path": "note.md", "fields": { "status": "active", "priority": 1 } }',
      '{ "path": "note.md", "fields": { "deprecated_field": null } }  // deletes the key',
    ],
  },
  manage_tags: {
    description: "Add, remove, or list tags on a note (frontmatter and inline)",
    args: '{ "path": "string", "action": "add|remove|list", "tags?": ["string"] }',
    examples: [
      '{ "path": "note.md", "action": "list" }',
      '{ "path": "note.md", "action": "add", "tags": ["important", "reviewed"] }',
      '{ "path": "note.md", "action": "remove", "tags": ["draft"] }',
    ],
  },
  rename_tag: {
    description: "Rename a tag across all notes in the vault (frontmatter + inline)",
    args: '{ "oldTag": "string", "newTag": "string" }',
    examples: ['{ "oldTag": "architecture", "newTag": "arch" }'],
  },

  // Graph
  backlinks: {
    description: "Find all notes that link TO a given note via [[wikilinks]]",
    args: '{ "path": "string" }',
    examples: ['{ "path": "microservices.md" }'],
  },
  forwardlinks: {
    description: "Find all notes linked FROM a given note",
    args: '{ "path": "string" }',
    examples: ['{ "path": "project-overview.md" }'],
  },
  graph_path: {
    description: "Find the shortest path between two notes in the knowledge graph",
    args: '{ "from": "string", "to": "string" }',
    examples: ['{ "from": "project-overview.md", "to": "user-service.md" }'],
  },
  graph_statistics: {
    description: "Knowledge graph stats — most connected nodes, orphans, density",
    args: "{}",
    examples: ["{}"],
  },

  // System
  get_stats: {
    description: "Vault and index statistics — note count, chunks, embeddings, graph density",
    args: "{}",
    examples: ["{}"],
  },
  reindex: {
    description: "Force a full reindex of the vault",
    args: "{}",
    examples: ["{}"],
  },
};

const TOOL_CATEGORIES: Record<string, string[]> = {
  Search: ["search_semantic", "search_text", "search_graph", "search_hybrid"],
  Read: ["read_note", "read_multiple_notes", "list_notes"],
  Write: ["create_note", "update_note", "delete_note", "move_note"],
  Metadata: ["get_frontmatter", "update_frontmatter", "manage_tags", "rename_tag"],
  Graph: ["backlinks", "forwardlinks", "graph_path", "graph_statistics"],
  System: ["get_stats", "reindex"],
};

function printToolList() {
  console.log("\nSemantic Pages — 21 MCP Tools\n");
  console.log("Usage: These tools are available via MCP when the server is running.");
  console.log("       Run `semantic-pages tools <name>` for details on a specific tool.\n");

  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    console.log(`  ${category}:`);
    for (const name of tools) {
      const tool = TOOL_HELP[name];
      console.log(`    ${name.padEnd(24)} ${tool.description}`);
    }
    console.log();
  }

  console.log("Run `semantic-pages tools <tool-name>` for arguments and examples.");
}

function printToolDetail(name: string) {
  const tool = TOOL_HELP[name];
  if (!tool) {
    console.error(`Unknown tool: ${name}`);
    console.error(`Run \`semantic-pages tools\` to see all available tools.`);
    process.exit(1);
  }

  console.log(`\n  ${name}`);
  console.log(`  ${"─".repeat(name.length)}`);
  console.log(`  ${tool.description}\n`);
  console.log(`  Arguments:`);
  console.log(`    ${tool.args}\n`);
  console.log(`  Examples:`);
  for (const ex of tool.examples) {
    console.log(`    ${ex}`);
  }
  console.log();
}

program
  .name("semantic-pages")
  .description(
    "Semantic search + knowledge graph MCP server for markdown files\n\n" +
    "  Start MCP server:  semantic-pages --notes ./vault\n" +
    "  Show vault stats:  semantic-pages --notes ./vault --stats\n" +
    "  Force reindex:     semantic-pages --notes ./vault --reindex\n" +
    "  List MCP tools:    semantic-pages tools\n" +
    "  Tool details:      semantic-pages tools search_semantic"
  )
  .version("0.4.1");

program
  .command("tools [name]")
  .description("List all MCP tools, or show details for a specific tool")
  .action((name?: string) => {
    if (name) {
      printToolDetail(name);
    } else {
      printToolList();
    }
    process.exit(0);
  });

program
  .command("serve", { isDefault: true })
  .description("Start the MCP server (default command)")
  .requiredOption("--notes <path>", "Path to markdown notes directory")
  .option("--reindex", "Force full reindex and exit")
  .option("--stats", "Show vault statistics and exit")
  .option("--model <name>", "Embedding model to use", "nomic-ai/nomic-embed-text-v1.5")
  .option("--workers <n>", "Number of worker threads for parallel embedding", parseInt)
  .option("--batch-size <n>", "Texts per ONNX forward pass (default: 32)", parseInt)
  .option("--no-watch", "Disable file watcher")
  .action(async (opts) => {
    const notesPath = resolve(opts.notes);

    if (!existsSync(notesPath)) {
      console.error(`Error: notes directory not found: ${notesPath}`);
      process.exit(1);
    }

    if (opts.stats) {
      const { Indexer } = await import("../core/indexer.js");
      const indexer = new Indexer(notesPath);
      const docs = await indexer.indexAll();
      console.log(`Notes: ${docs.length}`);
      console.log(`Chunks: ${docs.reduce((n: number, d: any) => n + d.chunks.length, 0)}`);
      console.log(`Wikilinks: ${docs.reduce((n: number, d: any) => n + d.wikilinks.length, 0)}`);
      console.log(`Tags: ${new Set(docs.flatMap((d: any) => d.tags)).size} unique`);
      process.exit(0);
    }

    if (opts.reindex) {
      const { createServer } = await import("../mcp/server.js");
      await createServer(notesPath, {
        watch: false,
        waitForReady: true,
        model: opts.model,
        workers: opts.workers,
        batchSize: opts.batchSize,
        onProgress: (embedded, total) => {
          process.stderr.write(`\rEmbedding ${embedded}/${total} chunks...`);
        },
      });
      process.stderr.write("\n");
      console.log("Reindex complete.");
      process.exit(0);
    }

    // Default: start MCP server on stdio
    const { startServer } = await import("../mcp/server.js");
    await startServer(notesPath, { watch: opts.watch, model: opts.model, workers: opts.workers, batchSize: opts.batchSize });
  });

program.parse();
