// Bundles the API into one file for its container, the way bootstrap is built (docs/README.md §12, bootstrap
// build): the workspace packages are consumed from source, so bundling is the build, and the runtime image
// carries dist/index.js and nothing else. Pino's default destination (stdout) needs no worker file, so the bundle
// is self-contained.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'inline',
  loader: { '.zed': 'text' },
  // CommonJS dependencies bundled into an ES module need a `require` in scope (esbuild's documented pattern).
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
