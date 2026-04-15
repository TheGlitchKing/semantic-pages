---
name: semantic-first
description: Route documentation lookups, internal procedure questions, repo architectural/vocabulary/convention questions, and research tasks through the semantic-pages and semantic-vault MCP servers BEFORE falling back to any other search strategy. Use this skill whenever the user asks how something works in this repo, what the convention is, where a procedure or guide lives, what the project calls something, why code is structured a certain way, OR asks any research question — comparative evaluations ("is there a better X"), tool/library/API recommendations ("what's the best X for Y"), best-of surveys, or any "look into X" / "research X" / "investigate X" phrasing. Also use for all research note-taking — findings go into .claude/.vault as markdown with structured frontmatter, not scattered across the conversation. Triggers on prose/conceptual questions about a codebase or domain, not on pure code-symbol lookups (those are Grep jobs). Ships with the semantic-pages plugin and probes MCP availability at runtime — the docs-lookup flow degrades gracefully when hit-em-with-the-docs is not installed, and the vault-research flow degrades gracefully when semantic-pages itself isn't wired up.
---

# semantic-first

Route documentation and research through the semantic-pages ecosystem before anything else.

## Why this skill exists

The semantic-pages plugin installs one or two MCP servers depending on what else is present:

- **`semantic-vault`** — semantic + keyword search and full read/write over `.claude/.vault/`, a research scratchpad that persists across sessions. Available whenever the semantic-pages plugin is installed.
- **`semantic-pages`** — the same engine pointed at a read-only docs index (by default `.documentation/`). Available only when the companion plugin `hit-em-with-the-docs` is also installed, since that's the plugin that owns the docs directory structure.

Without explicit routing, Claude's default reflex is to `Grep`/`Glob` the repo when the user asks a conceptual question, and to dump web-research findings straight into the chat where they're lost when the session ends. Both defaults waste the infrastructure the user set up. This skill corrects that.

## Two flows, gated independently

This skill has two flows, and they depend on different MCP servers. Probe each one independently — don't assume that if one works the other does, and don't no-op the whole skill just because half of it is unavailable.

| Flow | What it does | Depends on | Tool namespace |
|---|---|---|---|
| **A. Docs lookup** | Find how something works in this repo | `hit-em-with-the-docs` being installed | `mcp__semantic-pages__*` |
| **B. Research notes** | Capture findings to a persistent vault | `semantic-pages` being installed (which it is, since this skill ships with it — but the user can still have the MCP misconfigured) | `mcp__semantic-vault__*` |

## Flow A — documentation / procedure / repo-nuance lookups

**Triggers on prose questions about the current repo or project:**

- "How does this repo handle X?"
- "Where's the guide for Y?"
- "What's our process for Z?"
- "Why is this structured this way?"
- "What does this project call X?"
- "Is there a convention for Y?"
- "Is there a `<thing>` in this repo that does X?" — note this is **prose about whether a capability exists**, which semantic-pages answers well from design docs, even though a naive read would send it to Grep.

**Does NOT trigger on code-symbol lookups** like "where is function `parseAuth` defined" or "show me the `User` class" — those are `Grep`/`Glob` jobs. The line is *prose vs. symbol*: if the answer is a line or two of prose that would typically live in a design doc, README, or procedure, this flow applies. If the answer is a specific file path and line number that only exists in source code, it doesn't.

**When in doubt, try semantic-pages first anyway.** The cost of one extra `search_hybrid` call is tiny; the cost of grep-spelunking for something that's documented in plain English is several wasted minutes.

**Procedure:**

1. **Probe availability** once per task. Call `mcp__semantic-pages__get_stats` with no arguments. If the tool is not in the session, or `get_stats` errors, or the stats show an empty/missing index, drop to [Fallback: docs lookup](#fallback-docs-lookup) below. Otherwise the index is live and you can search it.
2. **Search with hybrid retrieval.** Use `mcp__semantic-pages__search_hybrid` with the user's question (or a condensed form of it) as the query. Hybrid search combines semantic embeddings with keyword matching and outperforms either individually for most real questions. Keep `top_k` modest (5–10); you can always widen if the first pass is thin.
3. **Read the top hits in full.** For each promising result, call `mcp__semantic-pages__read_note`. Do not answer from search snippets alone — snippets lose surrounding context and produce confident-sounding wrong answers. Reading 2–3 full notes is almost always cheaper than correcting a wrong answer later.
4. **Traverse the graph when the question is multi-part.** If a note references `[[wikilinks]]` or has `dependencies:` / `related:` frontmatter, use `mcp__semantic-pages__forwardlinks` / `backlinks` to follow the chain. This is especially valuable for questions like "how does X work end-to-end" or "what's the deploy process for each environment" — where the full answer is spread across linked notes.
5. **Answer from what you read, with filename citations.** Tell the user which notes you pulled the answer from so they can jump to the source. If the answer genuinely isn't in the index, say so explicitly — don't backfill with guesses or pivot silently to web search.

### Fallback: docs lookup

If step 1 indicates the `semantic-pages` MCP is unavailable (the `hit-em-with-the-docs` plugin isn't installed, the `.mcp.json` isn't wired up, or the index is empty), degrade:

- Tell the user, in one sentence, that the semantic docs index isn't available and you're falling back to direct file search. Visibility matters — it lets them fix the config and get the fast path back.
- Use `Glob` to enumerate `*.md` files in likely locations: `docs/`, `documentation/`, `.documentation/`, `README.md`, `CONTRIBUTING.md`, `.claude/`, and the repo root.
- Use `Grep` for keywords from the question across those files.
- If nothing promising turns up in markdown, *then* expand to `Grep` over source code as a last resort.

This is strictly worse than semantic search — but a visible fallback is much better than a silent one.

## Flow B — research tasks (internal or external)

**Triggers on evaluative, comparative, or exploratory questions:**

- "Is there a better X than Y?"
- "What's the best X for Y?"
- "Look into X."
- "Research Y."
- "Investigate how other projects solve Z."
- Any request that would naturally involve `WebSearch` / `WebFetch`.

**Also triggers on mixed questions** like "how does this repo use X, and is there a better alternative?" — handle the repo half via Flow A, then continue into Flow B for the alternatives half. The two flows compose naturally.

**Procedure:**

1. **If the question has a repo-context component, do Flow A first.** "How do we currently handle X" before "is there a better X" — you can't evaluate alternatives without understanding the current solution.
2. **Probe vault availability.** Call `mcp__semantic-vault__get_stats`. If it errors or the tool isn't present, drop to [Fallback: vault notes](#fallback-vault-notes). Otherwise the vault is live.
3. **Check the vault for prior research.** Call `mcp__semantic-vault__search_hybrid` with the topic. If past-you already investigated this, reuse the note — update it in place via `mcp__semantic-vault__update_note` rather than starting over. This is the main reason the vault exists.
4. **Do the actual research.** Use `WebSearch` / `WebFetch` / whatever tools are appropriate. Read multiple sources where you can — a single source is a single opinion.
5. **Write the findings to `.claude/.vault` as you go.** Use `mcp__semantic-vault__create_note` (or `update_note`). The full frontmatter format is in `references/vault-frontmatter.md` — read that file once per session before writing your first note.
6. **Link the note.** Use `[[wikilinks]]` to related notes in the body, and fill in `dependencies` / `related` / `supersedes` in the frontmatter so future sessions can traverse the graph. Unlinked notes are graveyards — they get written once and never found again.
7. **Answer the user from the note you just wrote.** The note is the canonical artifact; the chat response is a short summary with a pointer to the filename. The user's future self (or another session) can re-read the note; they can't re-read the chat.

### Fallback: vault notes

If step 2 indicates the `semantic-vault` MCP is unavailable but `.claude/.vault/` exists as a directory (or you can create it), use the `Write` tool directly — still follow the frontmatter format in `references/vault-frontmatter.md`. A session without the MCP server still has a filesystem; don't skip note-taking just because the semantic indexing won't happen. The index can be rebuilt later; lost notes can't.

If neither the MCP nor a filesystem `.claude/.vault/` directory is available *and* you can't create it (e.g., permission error), tell the user and put the findings directly in the chat as a clearly-marked "research findings" block — better than losing them entirely.

## The vault frontmatter is non-negotiable

Every `.md` file created in `.claude/.vault/` must start with YAML frontmatter. See `references/vault-frontmatter.md` for the full field reference and rationale. The short version is that the format is adapted from the 22-field docs frontmatter used elsewhere in the semantic-pages ecosystem, with the RAG-chunker fields dropped and two research-specific fields (`source`, `confidence`) added. A note without frontmatter won't index properly and becomes invisible to future searches — which defeats the whole point of writing it.

## Interaction with other Claude systems

- **The memory system** (`~/.claude/projects/**/memory/`) is for durable facts about the user and the project (who they are, what they prefer, what constraints are in play). It is NOT for research artifacts. Research goes in the vault; facts go in memory. When in doubt: *is this a body of findings on a specific topic?* → vault. *Is this a fact that would be useful to a completely different task?* → memory.
- **`Grep`/`Glob`** are for code-symbol lookups and as a Flow A fallback. Not the default for conceptual prose questions when semantic-pages is available.
- **`WebSearch`/`WebFetch`** are research *inputs* — their outputs should flow into vault notes, not into the conversation only. The chat response summarizes; the note preserves.

## What success looks like

- User asks "how does this repo handle auth?" → you call `search_hybrid`, read 2–3 notes, answer with filename citations. Tool call budget: 3–5. No `Grep`.
- User asks "what's the best CRM for small businesses?" → you search the vault for prior research (none), do web research, write `.claude/.vault/crm-smb-evaluation.md` with full frontmatter, answer from the note.
- User asks the same CRM question a week later → you find the existing note in the vault, skim it, either answer directly or update it with fresh findings and bump `last_updated`.
- User installs the skill in a repo without `hit-em-with-the-docs` → Flow A probe fails, you tell the user once, fall back to Glob/Grep for docs lookup. Flow B (vault) still works because `semantic-vault` is available.
- User's `.mcp.json` is broken entirely → both probes fail, you tell them, fall back to filesystem for both flows. You don't pretend everything's fine.

## What failure looks like

- Grep'ing the repo for a conceptual question when `mcp__semantic-pages__search_hybrid` is sitting right there.
- Writing research findings into the chat response and leaving no artifact on disk.
- Writing vault notes without frontmatter, or with ad-hoc frontmatter that won't index.
- Silently no-op'ing when an MCP server is missing instead of telling the user and falling back.
- Triggering on code-symbol lookups ("where is `parseAuth` defined") and wasting tool calls on semantic search for something `Grep` would answer in 100ms.
- Assuming both MCP servers travel together. They don't — the vault ships with this plugin, the docs index ships with `hit-em-with-the-docs`. Probe them separately.
