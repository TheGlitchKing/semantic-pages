# semantic-pages — Research Notes

## Why semantic-pages exists

Any project can have a folder of markdown notes — a `vault/`, `docs/`, `notes/`, or wiki.
There is no good tool that gives Claude semantic search + knowledge graph over those files
without requiring Docker, Python, or a running GUI app.

semantic-pages is that tool. Point it at any directory of `.md` files in any repo and it works.

## What semantic-pages is NOT

- Not a note editor — users write notes in Obsidian, VS Code, or any editor
- Not a visual graph — Obsidian's graph view is still the best UI for that
- Not a sync tool — git handles that

semantic-pages is purely the Claude-facing layer: semantic search + graph traversal over whatever
markdown files exist in the repo. The human experience stays unchanged.

## Key design decisions

### Pure Node.js (no Python)
`@huggingface/transformers` runs embedding models via WASM in Node.js.
No Python runtime needed. This keeps the install to `npx semantic-pages`.

### Local embedding model
Models are downloaded once to `~/.semantic-pages/models/` and run locally.
No API key, no network dependency after first run.
`nomic-embed-text-v1.5` is the preferred default — good quality, ~80MB.

### File-backed index
All index data lives in `.semantic-pages-index/` inside the vault (gitignored).
The vault `.md` files are the source of truth — the index is a derived cache.
Throw it away and rebuild with `semantic-pages --reindex`.

### Graph from wikilinks
Obsidian's graph view works because notes link to each other with `[[wikilinks]]`.
semantic-pages extracts these links to build a directed graph — same mental model, no Obsidian needed.

### HNSW for vector search
HNSWlib is the same algorithm used by most production vector DBs.
`hnswlib-node` binds to the C++ library — fast, file-backed, no server needed.

## Reference links

- `@huggingface/transformers` WASM: https://huggingface.co/docs/transformers.js
- `hnswlib-node`: https://github.com/yoshoku/hnswlib-node
- `graphology`: https://graphology.github.io/
- `@modelcontextprotocol/sdk`: https://github.com/modelcontextprotocol/typescript-sdk
- `nomic-embed-text-v1.5` on HuggingFace: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
