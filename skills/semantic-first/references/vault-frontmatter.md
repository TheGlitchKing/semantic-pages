# Vault note frontmatter — field reference

Every `.md` file written into `.claude/.vault/` must start with YAML frontmatter in this exact format. The schema is adapted from the 22-field docs frontmatter used by the semantic-pages ecosystem, with RAG-chunker fields removed (they're meaningless for scratchpad notes) and two research-specific fields added (`source`, `confidence`) because research artifacts need epistemic provenance.

## The template

Copy this and fill it in for every new note. Don't skip fields — if a field doesn't apply, use `null`, `[]`, or the default shown in the comment. Missing fields break graph traversal and semantic indexing.

```yaml
---
title: "Note Title"
tier: research              # research | investigation | scratch | finding | decision
topic: null                 # short kebab-case topic, e.g. "hashicorp-vault", "crm-evaluation", or null
domains:                    # free-form list; common values: security, backend, frontend, devops, infrastructure, product, tooling, ai
  - security
audience:                   # who would find this note useful; free-form: self | team | all | <role>
  - self
tags:                       # free-form keyword tags; used by search_hybrid
  - secrets
  - vault
status: active              # active | superseded | draft | archived
last_updated: '2026-04-15'  # ISO date, quoted string
source: web-research        # web-research | docs-lookup | conversation | experimentation | mixed
complexity: low             # low | medium | high — how hard the topic is to reason about
confidence: medium          # low | medium | high — how much future-you should trust these notes
keywords:                   # precise search terms (more specific than tags)
  - hashicorp-vault
  - secret-management
dependencies: []            # notes that should be read first (filenames or [[wikilinks]])
related: []                 # parallel/complementary notes
supersedes: []              # notes this replaces (old investigations that are now wrong)
summary: One-sentence description of what this note contains.
owner: self                 # self | team | <username>
---
```

## Field-by-field rationale

| Field | Purpose | Notes |
|---|---|---|
| `title` | Human-readable. Shows up in search results. | Be specific: "HashiCorp Vault vs Infisical comparison" beats "Secrets research". |
| `tier` | What kind of note this is. | `research` = multi-source investigation. `investigation` = debugging a specific problem. `scratch` = quick notes, low confidence. `finding` = a conclusion distilled from research. `decision` = an architectural choice and its rationale. |
| `topic` | A coarse grouping tag. | Kebab-case. `null` if the note doesn't cluster with others. |
| `domains` | Broad technical areas. | Free-form list. Multiple is fine. Used for filtering. |
| `audience` | Who benefits from reading this. | Default `[self]`. Use `[team]` or `[all]` only if the note is a finished artifact worth sharing. |
| `tags` | Free-form keywords. | These are the primary filter dimension in `search_hybrid`. Err on the side of more tags. |
| `status` | Is this note still valid? | `active` for current work. `superseded` when replaced by a newer investigation (fill `supersedes` on the new note). `draft` for in-progress. `archived` when deliberately retired. |
| `last_updated` | ISO date, quoted. | Bump this on every edit, even small ones. |
| `source` | Where the information came from. | `web-research` = Google/WebFetch. `docs-lookup` = pulled from semantic-pages. `conversation` = came from the user in chat. `experimentation` = ran something and observed results. `mixed` = combination. This is epistemic provenance and matters for re-reading later. |
| `complexity` | How hard is this topic. | Affects reading-time expectations and whether future-you should budget extra time. |
| `confidence` | How much to trust this note. | The single most valuable field for research notes. `low` confidence on a CRM recommendation after reading one blog post is useful information; pretending it's `high` is worse than not writing the note at all. |
| `keywords` | Precise search terms. | More specific than `tags` — actual names, product names, technical terms that exact-match searches will hit. |
| `dependencies` | Prerequisite notes. | `[[wikilinks]]` or filenames. Lets the graph traversal follow "what should I read first?". |
| `related` | Parallel notes. | Complementary topics, not prerequisites. |
| `supersedes` | Notes this replaces. | When you revisit a topic and the old note is now wrong, list it here and mark the old note's `status: superseded`. |
| `summary` | One sentence. | This is what shows up in search snippets — make it dense and informative. |
| `owner` | Who wrote it. | `self` by default. `team` for shared findings. `<username>` if you want to attribute. |

## What got dropped from the 22-field docs format, and why

The published-docs format includes these fields that are *not* in the vault format:

- `feature` → merged into `topic` and `tags`. Research notes rarely map to a single feature.
- `version` → research notes aren't versioned artifacts; they're snapshots in time.
- `size_kb`, `line_count`, `read_time_min` → auto-computed by the docs metadata generator for RAG chunking. Irrelevant for scratchpad notes.
- `load_priority` → used by published docs to hint load order; not meaningful for vault notes.
- `chunk_strategy` → RAG chunking hint; not used by the vault indexer in the same way.

If the user ever decides to promote a vault note to published docs, they'll need to add these fields back. Until then, they're noise.

## Two fields added to the vault format

- `source` — where the findings came from. Not in the docs format because published docs are the source of truth. Research notes aren't — knowing whether a conclusion is based on a blog post, a spec, or an experiment is critical for judging its weight later.
- `confidence` — how confident past-you was. Research notes lose value quickly if future-you can't tell whether the author was confident or speculating. A note that says "this library is the best choice" with `confidence: low` is actionable; one without confidence information is a trap.

## Example: fully filled-in note

```yaml
---
title: "HashiCorp Vault vs Infisical for SMB secret management"
tier: research
topic: secrets-management
domains:
  - security
  - devops
audience:
  - self
  - team
tags:
  - secrets
  - hashicorp-vault
  - infisical
  - comparison
status: active
last_updated: '2026-04-15'
source: mixed
complexity: medium
confidence: medium
keywords:
  - hashicorp-vault
  - infisical
  - secret-management
  - smb
dependencies: []
related:
  - secrets-rotation-patterns.md
supersedes: []
summary: Comparison of HashiCorp Vault and Infisical for small-to-medium business secret management, with cost, ops overhead, and feature tradeoffs.
owner: self
---

# HashiCorp Vault vs Infisical for SMB secret management

## TL;DR

<one paragraph conclusion>

## What we currently do

<if Flow A surfaced this, summarize from semantic-pages findings and cite the docs>

## Options evaluated

### HashiCorp Vault
...

### Infisical
...

## Recommendation

<with explicit confidence level>
```
