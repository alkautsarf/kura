#!/usr/bin/env node
// Patches babel modules where bun --compile's CJS interop wraps default-export
// functions as { default: fn } namespace objects, breaking calls like
// `_debug("babel")` and `transformAsync(code)` from @opentui/solid/bun-plugin.
// Recurring across kura releases (v0.1.6, v0.1.7, v0.1.11, v0.1.12). See
// memory: feedback-ci-simulate-before-commit.md.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const patches = [
  {
    file: "node_modules/@babel/traverse/lib/path/index.js",
    find: "const debug = _debug(",
    replace: "const debug = (_debug.default || _debug)(",
  },
];

let applied = 0;
for (const { file, find, replace } of patches) {
  if (!existsSync(file)) continue;
  const src = readFileSync(file, "utf8");
  if (src.includes(replace)) continue;
  if (!src.includes(find)) continue;
  writeFileSync(file, src.replace(find, replace));
  console.log(`patched ${file}`);
  applied++;
}

if (applied === 0) console.log("babel patches already applied or not needed");
