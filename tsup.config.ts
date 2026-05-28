import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      cli: "src/cli.ts",
    },
    format: ["esm"],
    target: "node22",
    platform: "node",
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
  },
]);
