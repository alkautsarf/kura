#!/usr/bin/env node
// Patches babel modules where bun --compile's CJS interop wraps default-export
// functions as { default: fn } namespace objects, breaking calls like
// `_debug("babel")` and `transformAsync(code)` from @opentui/solid/bun-plugin.
// Recurring across kura releases (v0.1.6, v0.1.7, v0.1.11, v0.1.12). See
// memory: feedback-ci-simulate-before-commit.md.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const patches = [
  // @babel/traverse imports `debug` and calls _debug("babel"). bun --compile
  // wraps the import as a namespace object so the call fails. Try multiple
  // unwrappings (.default, .debug, then itself) and verify it's a function.
  {
    file: "node_modules/@babel/traverse/lib/path/index.js",
    find: "const debug = _debug(",
    replace: "const debug = (typeof _debug==='function'?_debug:(_debug&&typeof _debug.default==='function'?_debug.default:_debug&&typeof _debug.debug==='function'?_debug.debug:()=>()=>{}))(",
  },
  // Older patched form (1-level fallback) — replace with the 3-level form above.
  {
    file: "node_modules/@babel/traverse/lib/path/index.js",
    find: "const debug = (_debug.default || _debug)(",
    replace: "const debug = (typeof _debug==='function'?_debug:(_debug&&typeof _debug.default==='function'?_debug.default:_debug&&typeof _debug.debug==='function'?_debug.debug:()=>()=>{}))(",
  },
  // @opentui/solid/scripts/solid-plugin.ts imports transformAsync from
  // @babel/core. bun --compile's CJS interop sometimes leaves the named
  // binding undefined (the require returns { default: { transformAsync, ... } }
  // and the destructure picks nothing). Patch the IMPORT line to a namespace
  // form and extract transformAsync via a dual-key check so the binding is
  // always a function regardless of which wrapping bun produces.
  {
    file: "node_modules/@opentui/solid/scripts/solid-plugin.ts",
    find: 'import { transformAsync } from "@babel/core"',
    replace: 'import * as _babelCore from "@babel/core"\nconst transformAsync = (_babelCore && (_babelCore.transformAsync || (_babelCore.default && _babelCore.default.transformAsync))) || (() => { throw new Error("kura: babel transformAsync interop failed") })',
  },
  // Revert previously-patched call sites back to the clean form , the import
  // patch above gives us a working `transformAsync` so the call site no longer
  // needs the typeof-wrapper that itself crashed when transformAsync was nil.
  {
    file: "node_modules/@opentui/solid/scripts/solid-plugin.ts",
    find: "const transforms = await (typeof transformAsync==='function'?transformAsync:transformAsync.default||transformAsync.transformAsync)(code, {",
    replace: "const transforms = await transformAsync(code, {",
  },
  {
    file: "node_modules/@opentui/solid/scripts/solid-plugin.ts",
    find: "const transforms = await (transformAsync.default || transformAsync)(code, {",
    replace: "const transforms = await transformAsync(code, {",
  },
  // @babel/helper-replace-supers destructures `assignmentExpression`, etc.
  // from `_core.types`. bun --compile wraps `_core` as a namespace object so
  // `_core.types` resolves to undefined and the destructure throws "Cannot
  // destructure property 'assignmentExpression' from null or undefined value".
  // Unwrap with the same multi-level fallback pattern.
  {
    file: "node_modules/@babel/helper-replace-supers/lib/index.js",
    find: "} = _core.types;",
    replace: "} = _core.types || (_core.default && _core.default.types) || {};",
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
