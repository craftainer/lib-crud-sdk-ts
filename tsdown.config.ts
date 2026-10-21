import { defineConfig } from "tsdown";

// ESM only. Each entry becomes a package.json `exports` subpath (or the
// `bin`): keep this map and package.json's `exports`/`bin` in step (publint
// and attw verify the result). `idb` and `eventsource-parser` are dev
// dependencies inlined here so the published package has no dependencies.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cache/index": "src/cache/index.ts",
    "tanstack/index": "src/tanstack/index.ts",
    "codegen/cli": "src/codegen/cli.ts",
  },
  format: "esm",
  tsconfig: "tsconfig.build.json",
  dts: true,
  clean: true,
  sourcemap: true,
  noExternal: ["idb", "eventsource-parser"],
});
