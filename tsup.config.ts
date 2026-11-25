import { defineConfig } from "tsup";

export default defineConfig({
  // index → v16 client (unchanged); lean → percolator-lean v2 client.
  // Separate entries because the two clients export overlapping names.
  entry: { index: "src/v16/index.ts", lean: "src/lean/index.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
});
