import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

/**
 * Resolves .js imports to .ts files when the .js file doesn't exist.
 * Needed because the CLI's abi/ uses Node ESM ".js" extension convention.
 */
function resolveJsToTs(): Plugin {
  return {
    name: "resolve-js-to-ts",
    resolveId(source, importer) {
      if (!importer || !source.endsWith(".js")) return null;
      const dir = path.dirname(importer);
      const jsPath = path.resolve(dir, source);
      if (fs.existsSync(jsPath)) return null; // actual .js exists, leave it
      const tsPath = jsPath.replace(/\.js$/, ".ts");
      if (fs.existsSync(tsPath)) return tsPath;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), resolveJsToTs()],
  resolve: {
    alias: {
      "@parsers": path.resolve(__dirname, "../src/solana"),
      "@abi": path.resolve(__dirname, "../src/abi"),
      // Force Vite to use the npm buffer package instead of externalizing it
      buffer: "buffer/",
    },
  },
  define: {
    // @solana/web3.js needs Buffer and process in the browser
    "process.env": {},
    global: "globalThis",
  },
  optimizeDeps: {
    include: ["buffer"],
  },
});
