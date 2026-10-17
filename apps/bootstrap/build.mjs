// Bundles the bootstrap script into one file for its container (docs/README.md §12, 2026-10-15 bootstrap build).
// Workspace packages are consumed from source, so bundling is the build: esbuild follows the imports into
// packages/*/src and the runtime image carries dist/index.js and nothing else.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'inline',
  // The SpiceDB schema is bundled as a string (packages/authz/src/schema.ts).
  loader: { '.zed': 'text' },
  // CommonJS dependencies bundled into an ES module need a `require` in scope (esbuild's documented pattern).
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
