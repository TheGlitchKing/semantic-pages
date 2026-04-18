// Plugin-specific SessionStart reconciliation for semantic-pages.
//
// Ensures <project>/.claude/.vault exists. Reconciles .mcp.json so the
// "semantic-vault" entry always points at ./.claude/.vault, and adds
// (or removes) a read-only "semantic-pages" entry pointed at
// ./.documentation only when hit-em-with-the-docs is enabled and the
// .documentation directory exists.
//
// Idempotent: only writes .mcp.json when the computed JSON differs from
// what's on disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PKG = "@theglitchking/semantic-pages";

function readJson(path, fallback = null) {
  try {
    const raw = readFileSync(path, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function hewtdEnabled() {
  const settings = readJson(join(homedir(), ".claude", "settings.json"));
  const enabled = settings?.enabledPlugins || {};
  return Object.keys(enabled).some(
    (k) => k.startsWith("hit-em-with-the-docs@") && enabled[k] === true,
  );
}

export function reconcile(projectRoot) {
  const vaultDir = join(projectRoot, ".claude", ".vault");
  const docsDir = join(projectRoot, ".documentation");
  const mcpPath = join(projectRoot, ".mcp.json");

  try { mkdirSync(vaultDir, { recursive: true }); } catch {}

  const docsWired = hewtdEnabled() && existsSync(docsDir);

  let data = { mcpServers: {} };
  if (existsSync(mcpPath)) {
    const parsed = readJson(mcpPath, null);
    if (parsed === null) {
      let raw = "";
      try { raw = readFileSync(mcpPath, "utf8"); } catch {}
      if (raw.trim()) {
        process.stderr.write(`semantic-pages hook: could not parse ${mcpPath}; leaving untouched\n`);
        return;
      }
    } else if (parsed && typeof parsed === "object") {
      data = parsed;
      if (!data.mcpServers || typeof data.mcpServers !== "object") {
        data.mcpServers = {};
      }
    }
  }

  const before = JSON.stringify(data);

  data.mcpServers["semantic-vault"] = {
    type: "stdio",
    command: "npx",
    args: ["-y", `${PKG}@latest`, "--notes", "./.claude/.vault"],
  };

  if (docsWired) {
    data.mcpServers["semantic-pages"] = {
      type: "stdio",
      command: "npx",
      args: ["-y", `${PKG}@latest`, "--notes", "./.documentation", "--read-only"],
    };
  } else if (data.mcpServers["semantic-pages"]) {
    const existing = data.mcpServers["semantic-pages"];
    const args = Array.isArray(existing.args) ? existing.args : [];
    const looksLikeOurs = args.some(
      (a) => typeof a === "string" && a.includes(".documentation"),
    );
    if (looksLikeOurs) delete data.mcpServers["semantic-pages"];
  }

  const after = JSON.stringify(data);
  if (after === before) return;

  mkdirSync(dirname(mcpPath), { recursive: true });
  writeFileSync(mcpPath, JSON.stringify(data, null, 2) + "\n");
}
