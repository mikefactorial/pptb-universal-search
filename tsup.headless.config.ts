import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/headless.ts"],
    format: ["cjs"],          // safest for Node runtime compatibility
    platform: "node",
    target: "node18",
    bundle: true,             // key: removes runtime relative import issues
    splitting: false,
    sourcemap: true,
    clean: false,
    outDir: "dist",
    outExtension: () => ({ js: ".cjs" }),
    external: [],             // include everything unless you intentionally externalize
});