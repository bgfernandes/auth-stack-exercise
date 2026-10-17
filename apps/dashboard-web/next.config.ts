import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image; the tracing root is the monorepo so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // `next dev` (under Tilt) would otherwise write an AGENTS.md into the app directory on every start.
  agentRules: false,
};

export default nextConfig;
