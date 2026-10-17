// Root Jest config with two projects. `unit` is the default and needs no infrastructure; `integration`
// matches *.integration.test.ts and is run only by `pnpm test:integration` against the compose stack.
const ignoredPaths = ['/node_modules/', '/dist/', '/.next/'];

/** @type {import('jest').Config} */
const shared = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
    '^.+\\.zed$': '<rootDir>/jest.text-transform.cjs',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'json', 'zed'],
  testPathIgnorePatterns: ignoredPaths,
  // openid-client, oauth4webapi, and jose ship ES modules only; Jest loads CommonJS, so they go through the
  // transform too (both paths pnpm gives them). Everything else in node_modules is left alone.
  transformIgnorePatterns: [
    '/node_modules/(?!(\\.pnpm/)?(openid-client|oauth4webapi|jose)[@/])',
    '\\.pnp\\.[^\\/]+$',
  ],
};

/** @type {import('jest').Config} */
export default {
  projects: [
    {
      ...shared,
      displayName: 'unit',
      testMatch: ['**/*.test.ts?(x)'],
      testPathIgnorePatterns: [...ignoredPaths, '\\.integration\\.test\\.tsx?$'],
    },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['**/*.integration.test.ts?(x)'],
    },
  ],
};
