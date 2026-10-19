import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image; the tracing root is the monorepo so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // `next dev` (under Tilt) would otherwise write an AGENTS.md into the app directory on every start.
  agentRules: false,
  // The app is served at its own hostname (docs/README.md §4.3), which `next dev` treats as a cross-origin
  // caller of its dev resources and refuses: the HMR websocket fails, and a page that calls `notFound()`,
  // which dev renders on the client from the error shell, stays empty (docs/TICKETS.md, ticket 13a).
  allowedDevOrigins: ['dashboard.localtest.me'],
};

export default nextConfig;
