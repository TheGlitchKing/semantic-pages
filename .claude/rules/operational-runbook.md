# template-ai-workspace — Operational Runbook

> Auto-loaded every session. Contains operational knowledge that cannot be derived from code.
> This file grows over time as the team discovers gotchas, quirks, and procedures.
> **Edit this file manually** — it is NOT overwritten on regeneration.

## Environment Differences

<!-- TODO: Document how dev/staging/prod differ (DB, deploy method, secrets, URLs) -->

| | Dev | Staging | Production |
|---|---|---|---|
| **URL** | | | |
| **Database** | | | |
| **Deploy** | | | |
| **Secrets** | | | |

## Known Issues & Workarounds

<!-- This section fills in naturally. When you hit a non-obvious issue, add it here. -->
<!-- Examples: "HMR doesn't work on WSL2", "port 6543 breaks migrations" -->

_No known issues documented yet. When you encounter a non-obvious problem and its solution, add it here so future sessions don't re-discover it._

## Deploy Procedures

### npm publish checklist

Before running `npm publish` (or bumping the version):

1. **Sync the CLI version string** — `src/cli/index.ts` has a `.version(...)` call in the
   `program` definition. It must match `package.json`. It currently reads dynamically from
   `package.json` via `createRequire`, so this is automatic — but if that line ever gets
   reverted to a hardcoded string, `semantic-pages --version` will lie.
   **Verify:** `node dist/cli/index.js --version` should print the version from `package.json`.

2. **Build before publish** — `prepublishOnly` runs `npm run build` automatically, but confirm
   the build is clean before tagging.

3. **Clear npx cache after publish** — consumers using `npx ... @latest` may be served a stale
   cached version. After publishing, clear the cache on affected machines:
   ```bash
   rm -rf ~/.npm/_npx/*/node_modules/@theglitchking
   ```

## Key Commands

| Command | What It Does |
|---------|-------------|
| `python .claude/project-map/generate.py --force` | Force-regenerate project map |
| `python .claude/project-map/grader.py` | Grade map quality (0-100%) |
| `bash .githooks/install.sh` | (Re)install git hooks |
| `bash .claude/install.sh` | Re-run full plugin installer |

## Dev Credentials

<!-- Add test/dev credentials here (NEVER production secrets) -->
