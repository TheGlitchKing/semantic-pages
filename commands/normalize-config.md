---
description: Rewrite fragile npx-@latest entries in .mcp.json to the stable node-against-node_modules form
allowed-tools: Bash(npx:*)
---

Run `npx --no @theglitchking/semantic-pages normalize-config` and report the result to the user. Mention that `.mcp.json.bak` was created as a safety backup, and that the MCPs need to be toggled in `/mcp` to pick up the change.
