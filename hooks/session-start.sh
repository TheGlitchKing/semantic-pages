#!/usr/bin/env bash
#
# semantic-pages SessionStart hook
#
# Reconciles the project's .mcp.json so that:
#   1. A "semantic-vault" entry always points at ./.claude/.vault (read/write).
#   2. A "semantic-pages" entry points at ./.documentation (read-only) ONLY IF
#      both conditions hold:
#        - hit-em-with-the-docs is installed+enabled as a Claude Code plugin
#        - ./.documentation/ exists in this project
#      Otherwise any stale "semantic-pages" entry is removed.
#
# Idempotent: only writes .mcp.json when the computed JSON differs from disk.
# Fails open: any error logs to stderr and exits 0 so Claude Code isn't blocked.
#
# Runs on every SessionStart event. Keeps wiring in sync with plugin state.

set -u

# Fail-open: if anything goes sideways, swallow and return the empty SessionStart
# response so the session keeps going.
trap 'emit_empty_response; exit 0' ERR

emit_empty_response() {
  # SessionStart hooks need to return JSON; empty additionalContext is fine.
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart"}}\n'
}

log() {
  printf 'semantic-pages hook: %s\n' "$*" >&2
}

# Project root is cwd when Claude Code invokes the hook.
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$PROJECT_ROOT" || { emit_empty_response; exit 0; }

VAULT_DIR="$PROJECT_ROOT/.claude/.vault"
DOCS_DIR="$PROJECT_ROOT/.documentation"
MCP_JSON="$PROJECT_ROOT/.mcp.json"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# 1. Ensure .claude/.vault exists (idempotent).
mkdir -p "$VAULT_DIR" 2>/dev/null || true

# 2. Detect hit-em-with-the-docs: must be listed in enabledPlugins in
#    ~/.claude/settings.json (covers any marketplace source).
HEWTD_ENABLED=0
if [ -f "$CLAUDE_SETTINGS" ]; then
  if node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const enabled = s.enabledPlugins || {};
      const hit = Object.keys(enabled).some(
        (k) => k.startsWith("hit-em-with-the-docs@") && enabled[k] === true
      );
      process.exit(hit ? 0 : 1);
    } catch { process.exit(1); }
  ' "$CLAUDE_SETTINGS" 2>/dev/null; then
    HEWTD_ENABLED=1
  fi
fi

# 3. Docs MCP entry is conditional on BOTH hewtd enabled AND .documentation present.
DOCS_WIRED=0
if [ "$HEWTD_ENABLED" = "1" ] && [ -d "$DOCS_DIR" ]; then
  DOCS_WIRED=1
fi

# 4. Reconcile .mcp.json using node (cross-platform JSON edit, idempotent write).
node - "$MCP_JSON" "$DOCS_WIRED" <<'NODE' || { log "reconcile failed"; emit_empty_response; exit 0; }
const fs = require("fs");
const path = require("path");
const [, , mcpPath, docsWiredArg] = process.argv;
const docsWired = docsWiredArg === "1";

let data = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    const raw = fs.readFileSync(mcpPath, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") data = parsed;
    if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
  } catch (err) {
    // Corrupt .mcp.json — leave it alone and emit a note to stderr
    process.stderr.write(
      `semantic-pages hook: could not parse ${mcpPath} (${err.message}); leaving untouched\n`
    );
    process.exit(0);
  }
}

// Canonical entries
const vaultEntry = {
  type: "stdio",
  command: "npx",
  args: [
    "-y",
    "@theglitchking/semantic-pages@latest",
    "--notes",
    "./.claude/.vault",
  ],
};

const docsEntry = {
  type: "stdio",
  command: "npx",
  args: [
    "-y",
    "@theglitchking/semantic-pages@latest",
    "--notes",
    "./.documentation",
    "--read-only",
  ],
};

const before = JSON.stringify(data);

// Always ensure semantic-vault
data.mcpServers["semantic-vault"] = vaultEntry;

// semantic-pages (docs) is conditional
if (docsWired) {
  data.mcpServers["semantic-pages"] = docsEntry;
} else if (data.mcpServers["semantic-pages"]) {
  // Only remove if it looks like ours (points at .documentation). Don't clobber
  // a user-custom entry under the same name.
  const existing = data.mcpServers["semantic-pages"];
  const args = Array.isArray(existing.args) ? existing.args : [];
  const looksLikeOurs =
    args.some((a) => typeof a === "string" && a.includes(".documentation"));
  if (looksLikeOurs) delete data.mcpServers["semantic-pages"];
}

const after = JSON.stringify(data, null, 2) + "\n";

// Only write if content actually changed — prevents needless git churn.
if (JSON.stringify(JSON.parse(after)) === before) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, after);
NODE

emit_empty_response
exit 0
