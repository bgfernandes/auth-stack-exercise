import path from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image; the tracing root is the monorepo so workspace packages are included.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
};

export default nextConfig;
