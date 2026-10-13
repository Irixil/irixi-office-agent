import { defineConfig } from "tsup";
import { builtinModules } from "node:module";

const bundleAll = !!process.env.BUNDLE_ALL;

// Inject createRequire so CJS deps (ws, ably) can require() Node builtins in ESM bundle
const requireShim = bundleAll
  ? 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);'
  : "";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: bundleAll ? [/(.*)/] : ["@office/shared"],
  external: bundleAll ? builtinModules.flatMap((m) => [m, `node:${m}`]) : [],
  banner: {
    js: `#!/usr/bin/env node\n${requireShim}`,
  },
});
