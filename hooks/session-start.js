#!/usr/bin/env node
// semantic-pages SessionStart hook. Delegates lifecycle + update-check to
// @theglitchking/claude-plugin-runtime; plugin-specific .mcp.json wiring
// lives in ./reconcile.js.

import { runSessionStart } from "@theglitchking/claude-plugin-runtime";
import { reconcile } from "./reconcile.js";

await runSessionStart({
  packageName: "@theglitchking/semantic-pages",
  pluginName: "semantic-pages",
  configFile: "semantic-pages.json",
  reconcile,
});
