#!/usr/bin/env node

import { program } from "commander";
import { resolve, join, dirname, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { registerUpdateCommands } from "@theglitchking/claude-plugin-runtime";

const require_ = createRequire(import.meta.url);
const { version } = require_("../../package.json") as { version: string };

const PKG_NAME = "@theglitchking/semantic-pages";

function runRelink(cwd: string) {
  const linker = join(cwd, "node_modules", "@theglitchking", "semantic-pages", "scripts", "link-skills.js");
  const script = existsSync(linker) ? linker : resolve(process.cwd(), "scripts", "link-skills.js");
  if (!existsSync(script)) {
    console.error("link-skills.js not found — is the package installed?");
    return;
  }
  spawnSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, INIT_CWD: cwd },
    stdio: "inherit",
  });
}

function findLocalBin(cwd: string): string | null {
  const p = join(cwd, "node_modules", "@theglitchking", "semantic-pages", "bin", "semantic-pages");
  return existsSync(p) ? p : null;
}

function localBinArg(cwd: string): string | null {
  const abs = findLocalBin(cwd);
  if (!abs) return null;
  const rel = relative(cwd, abs);
  return rel.startsWith("..") ? abs : `./${rel}`;
}

function readJsonSafe(path: string): any {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Returns the fragile npx-form pattern we used to write in pre-0.10.0
 * SessionStart hooks, so normalize-config can detect and rewrite it.
 */
function isNpxForm(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return cmd === "npx" && args.some((a: unknown) => typeof a === "string" && a.includes(PKG_NAME));
}

function isLocalForm(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = entry.command;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return (
    cmd === "node" &&
    args.some((a: unknown) => typeof a === "string" && a.includes("node_modules/@theglitchking/semantic-pages"))
  );
}

function extractNotesPath(entry: any): string | null {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  const i = args.indexOf("--notes");
  if (i === -1 || i + 1 >= args.length) return null;
  return String(args[i + 1]);
}

function extractExtraFlags(entry: any): string[] {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  return args.filter((a: unknown): a is string => typeof a === "string" && a.startsWith("--") && a !== "--notes");
}

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
  .version(version);

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
  .option("--wait-for-ready", "Block startup until index is fully built before serving (default: index in background; tools return 'Indexing in progress' until ready)")
  .option("--read-only", "Suppress write tools (create_note, update_note, delete_note, move_note, update_frontmatter, manage_tags, rename_tag) — use for shared docs vaults owned by another tool")
  .option("--model <name>", "Embedding model to use (default: all-MiniLM-L6-v2, fast; use nomic-ai/nomic-embed-text-v1.5 for higher quality)")
  .option("--workers <n>", "Number of worker threads for parallel embedding", parseInt)
  .option("--batch-size <n>", "Texts per ONNX forward pass (default: 8)", parseInt)
  .option("--no-quantized", "Use full-precision model instead of quantized (slower, slightly higher quality)")
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
        quantized: opts.quantized,
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
    await startServer(notesPath, {
      watch: opts.watch,
      waitForReady: opts.waitForReady,
      model: opts.model,
      workers: opts.workers,
      batchSize: opts.batchSize,
      quantized: opts.quantized,
      readOnly: opts.readOnly,
    });
  });

registerUpdateCommands(program, {
  packageName: PKG_NAME,
  pluginName: "semantic-pages",
  configFile: "semantic-pages.json",
  onAfterUpdate: (cwd) => runRelink(cwd),
});

program
  .command("normalize-config")
  .description(
    "Rewrite fragile `npx @latest` entries in .mcp.json to the stable node-against-node_modules form (with backup and validation)",
  )
  .option("--dry-run", "print the proposed changes but don't write")
  .action((opts: { dryRun?: boolean }) => {
    const cwd = process.cwd();
    const mcpPath = join(cwd, ".mcp.json");
    if (!existsSync(mcpPath)) {
      console.log("no .mcp.json in current directory — nothing to do");
      process.exit(0);
    }
    const data = readJsonSafe(mcpPath);
    if (!data || typeof data !== "object" || !data.mcpServers || typeof data.mcpServers !== "object") {
      console.error(`could not parse ${mcpPath}`);
      process.exit(1);
    }
    const bin = localBinArg(cwd);
    if (!bin) {
      console.error(
        `no local install found at ./node_modules/@theglitchking/semantic-pages/bin/semantic-pages.\n` +
          `run 'npm install --save @theglitchking/semantic-pages' first, then re-run this command.`,
      );
      process.exit(1);
    }
    const rewritten: string[] = [];
    for (const [key, entry] of Object.entries<any>(data.mcpServers)) {
      if (!isNpxForm(entry)) continue;
      const notes = extractNotesPath(entry) ?? "./.claude/.vault";
      const extra = extractExtraFlags(entry);
      data.mcpServers[key] = {
        type: "stdio",
        command: "node",
        args: [bin, "--notes", notes, ...extra],
      };
      rewritten.push(key);
    }
    if (rewritten.length === 0) {
      console.log("no npx-form entries found — .mcp.json is already in the stable form.");
      process.exit(0);
    }
    console.log(`Rewriting ${rewritten.length} entr${rewritten.length === 1 ? "y" : "ies"}: ${rewritten.join(", ")}`);
    if (opts.dryRun) {
      console.log("--- proposed .mcp.json:");
      console.log(JSON.stringify(data, null, 2));
      console.log("--- (dry-run; no changes written)");
      process.exit(0);
    }
    // Back up
    const bakPath = join(dirname(mcpPath), ".mcp.json.bak");
    try {
      writeFileSync(bakPath, readFileSync(mcpPath, "utf8"));
      console.log(`backup written: ${bakPath}`);
    } catch (err: any) {
      console.error(`could not write backup: ${err.message}`);
      process.exit(1);
    }
    writeFileSync(mcpPath, JSON.stringify(data, null, 2) + "\n");

    // Verify the local bin starts cleanly. We just run --version — fast and
    // enough to catch ERR_MODULE_NOT_FOUND type failures.
    const verify = spawnSync("node", [bin, "--version"], { cwd, stdio: "pipe", timeout: 15_000 });
    if (verify.status !== 0) {
      console.error(`verification failed (exit ${verify.status}):\n${verify.stderr?.toString() || ""}`);
      console.error(`rolling back from ${bakPath}`);
      writeFileSync(mcpPath, readFileSync(bakPath, "utf8"));
      process.exit(1);
    }
    console.log(`✓ .mcp.json normalized and verified. Toggle the MCPs in /mcp to reconnect.`);
    process.exit(0);
  });

program
  .command("healthcheck")
  .description(
    "Verify the local install starts cleanly; self-heal common npx-cache corruption (ERR_MODULE_NOT_FOUND)",
  )
  .action(() => {
    const cwd = process.cwd();
    const bin = findLocalBin(cwd);
    if (!bin) {
      console.error(`no local install at ./node_modules/@theglitchking/semantic-pages/bin/semantic-pages`);
      console.error(`run 'npm install --save @theglitchking/semantic-pages' to install.`);
      process.exit(1);
    }

    // 1. Warn if .mcp.json uses the fragile form.
    const mcpPath = join(cwd, ".mcp.json");
    if (existsSync(mcpPath)) {
      const data = readJsonSafe(mcpPath);
      const entries = data?.mcpServers && typeof data.mcpServers === "object" ? Object.entries<any>(data.mcpServers) : [];
      const fragile = entries.filter(([, e]) => isNpxForm(e)).map(([k]) => k);
      if (fragile.length > 0) {
        console.warn(
          `⚠️  .mcp.json uses the fragile npx-@latest form for: ${fragile.join(", ")}`,
        );
        console.warn(`   Rewrite to the stable form:`);
        console.warn(`     npx --no @theglitchking/semantic-pages normalize-config`);
      }
    }

    // 2. Smoke-test the local bin.
    const r = spawnSync("node", [bin, "--version"], { cwd, stdio: "pipe", timeout: 15_000 });
    if (r.status === 0) {
      console.log(`✓ local install starts cleanly (v${r.stdout?.toString().trim()})`);
      process.exit(0);
    }

    const stderr = r.stderr?.toString() ?? "";

    // 3. Self-heal ERR_MODULE_NOT_FOUND in npx cache (rare but the classic
    //    failure mode that triggered 0.10.0). Extract the offending npx cache
    //    dir from the error message, rm -rf it, retry once.
    if (stderr.includes("ERR_MODULE_NOT_FOUND")) {
      const match = stderr.match(/([\/~][^'"\s]*\/_npx\/[^\/'"\s]+)/);
      if (match) {
        const bad = match[1];
        console.warn(`detected broken npx cache at ${bad} — clearing and retrying...`);
        try { rmSync(bad, { recursive: true, force: true }); } catch {}
        const r2 = spawnSync("node", [bin, "--version"], { cwd, stdio: "pipe", timeout: 15_000 });
        if (r2.status === 0) {
          console.log(`✓ cleared npx cache and verified (v${r2.stdout?.toString().trim()})`);
          process.exit(0);
        }
        console.error(`retry still failed:\n${r2.stderr?.toString() || ""}`);
      } else {
        console.error(`ERR_MODULE_NOT_FOUND but could not locate offending cache path in the error.`);
      }
    }

    console.error(stderr || `local install failed (exit ${r.status})`);
    process.exit(1);
  });

program.parse();
