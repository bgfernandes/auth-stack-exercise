// Root Jest config with two projects. `unit` is the default and needs no infrastructure; `integration`
// matches *.integration.test.ts and is run only by `pnpm test:integration` against the compose stack.
const ignoredPaths = ['/node_modules/', '/dist/', '/.next/'];

/** @type {import('jest').Config} */
const shared = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript', tsx: true }, target: 'es2022' },
        module: { type: 'commonjs' },
      },
    ],
    '^.+\\.zed$': '<rootDir>/jest.text-transform.cjs',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'json', 'zed'],
  // Sources use NodeNext resolution, so relative imports carry a .js extension that maps back to the .ts file.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testPathIgnorePatterns: ignoredPaths,
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
