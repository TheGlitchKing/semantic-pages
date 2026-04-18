#!/usr/bin/env node
// Postinstall — delegates to @theglitchking/claude-plugin-runtime.
// The runtime handles: skill symlinking, default policy config write, and
// settings.json hook registration with plugin/npm dedup. See the runtime's
// docs/PLUGIN_AUTHORING_SCAFFOLD.md for the full contract.

import { runPostinstall } from "@theglitchking/claude-plugin-runtime";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  runPostinstall({
    packageName: "@theglitchking/semantic-pages",
    pluginName: "semantic-pages",
    configFile: "semantic-pages.json",
    skillsDir: "skills",
    packageRoot,
    hookCommand:
      "node ./node_modules/@theglitchking/semantic-pages/hooks/session-start.js",
  });
} catch (err) {
  console.warn(`[semantic-pages] postinstall failed: ${err?.message || err}`);
}
