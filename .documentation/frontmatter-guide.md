# Frontmatter Guide

Semantic Pages works with **any** markdown files — no frontmatter required. But when frontmatter is present, it gets indexed and used to improve search relevance, enable date filtering, and expose structured metadata through every tool.

---

## What Gets Indexed Automatically (No Frontmatter Needed)

Every note, regardless of whether it has frontmatter, receives:

- **`mtime`** — a modification timestamp resolved in this order:
  1. `last_updated` frontmatter field (YYYY-MM-DD or ISO)
  2. `updated` frontmatter field
  3. `date` frontmatter field
  4. `lastmod` frontmatter field
  5. **`fs.stat` mtime** — the file's actual last-modified time on disk

  This means plain notes with no frontmatter still get a timestamp from the filesystem. Notes with explicit date fields use those instead, which is more reliable (e.g. after a `git clone` resets all file timestamps).

- **`title`** — from `frontmatter.title`, then the first heading, then the filename
- **`tags`** — from `frontmatter.tags` array and inline `#tags` in the body
- **`wikilinks`** — all `[[link]]` references in the body

---

## Optional Frontmatter Fields

When present, these fields are extracted and exposed through all search tools and `list_notes`. None are required.

### Date / Freshness

```yaml
last_updated: '2026-03-15'   # preferred — used as mtime
updated: '2026-03-15'        # alternative
date: '2026-03-15'           # alternative
lastmod: '2026-03-15'        # alternative (Hugo/Jekyll convention)
```

All four accept both `YYYY-MM-DD` and full ISO timestamps (`2026-03-15T10:00:00Z`).

### Relevance Weight

```yaml
load_priority: 8   # integer 1–10, default: none (neutral)
```

Boosts search scores in `search_semantic` and `search_hybrid`. A priority-10 document scores ~20% higher than its raw semantic score; priority-1 scores ~18% lower. Documents without `load_priority` are unaffected.

Use this to surface canonical or high-importance docs above others on similar topics.

### Classification

```yaml
status: active          # draft | active | deprecated | archived
tier: guide             # guide | standard | example | reference | admin
domains: [api, security]
purpose: "One-sentence summary of what this document covers"
```

These fields are returned on every search result and `list_notes` entry. You can also use them as filters:

```
# Only return active API guides modified this year
list_notes(status="active", domain="api", modifiedAfter="2026-01-01")
search_semantic("authentication flow", status="active", tier="guide")
```

---

## Minimal Example

```yaml
---
title: "Auth Guide"
status: active
last_updated: '2026-03-15'
load_priority: 9
---
```

That's all you need to get date filtering, priority boosting, and status filtering on a note.

---

## Full Schema Example

The fields above are compatible with [**hit-em-with-the-docs**](https://github.com/TheGlitchKing/hit-em-with-the-docs) — a self-managing documentation system for Claude Code that enforces a 22-field metadata schema, auto-classifies documents into 15 domains, and generates health reports. If you're using hit-em-with-the-docs to manage your vault, all its frontmatter fields index automatically with no extra configuration.

```yaml
---
title: "API Endpoints Guide"
tier: reference
domains: [api]
audience: [developers]
tags: [api, rest, endpoints]
status: active
last_updated: '2026-03-15'
version: '1.2.0'
purpose: "Complete reference for all API endpoints"
load_priority: 8
---
```

Fields not listed in this guide (`version`, `audience`, `author`, etc.) are stored in `frontmatter` on the `IndexedDocument` and accessible via `get_frontmatter` — they just don't receive special treatment during indexing or scoring.

---

## Filtering Reference

All search tools and `list_notes` accept these optional parameters when frontmatter is present:

| Parameter | Type | Description |
|-----------|------|-------------|
| `modifiedAfter` | ISO date string | Only notes with `mtime` after this date |
| `modifiedBefore` | ISO date string | Only notes with `mtime` before this date |
| `status` | string | Exact match on `status` field |
| `tier` | string | Exact match on `tier` field |
| `domain` | string | Notes where `domains` array contains this value |

Date filters work on **all** notes — even ones without frontmatter — because every note gets an `mtime` from the filesystem.

---

## Related

- [How It Works](./how-it-works.md) — full indexing pipeline
- [Performance Tuning](./performance-tuning.md) — search scoring and boosting
- [hit-em-with-the-docs](https://github.com/TheGlitchKing/hit-em-with-the-docs) — companion documentation management system
