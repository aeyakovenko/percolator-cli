import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/v16/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
});
