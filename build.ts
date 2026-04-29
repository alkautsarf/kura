#!/usr/bin/env bun
// Compile-time build script. Registers opentui-solid's babel-based JSX
// transform plugin so `Bun.build({ compile })` can process .tsx files.
// `bun build --compile` (the CLI) does NOT pick up bunfig.toml `preload`,
// so this Bun.build() programmatic invocation is the only path that works.

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const target = process.argv[2] ?? `bun-${process.platform}-${process.arch}`;
const outfile = process.argv[3] ?? `dist/kura-${target.replace(/^bun-/, "")}`;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "bun",
  compile: { target, outfile },
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);
