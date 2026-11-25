import { defineConfig } from "tsup";

export default defineConfig({
  // percolator-lean TypeScript client (the only client; v16 removed).
  entry: { index: "src/lean/index.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
});
