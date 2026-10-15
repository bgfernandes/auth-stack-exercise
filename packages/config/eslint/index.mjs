// Shared ESLint flat config. The root eslint.config.mjs calls createConfig(); apps and packages carry no config.
// Three layers: typescript-eslint with type information for every TypeScript file, import ordering, and the
// Next.js preset limited to the web apps. eslint-config-prettier goes last so no formatting rule survives.
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const SOURCE_FILES = ['**/*.{js,mjs,cjs,ts,tsx}'];
const TYPESCRIPT_FILES = ['**/*.{ts,tsx}'];
const WEB_APP_FILES = ['apps/*-web/**/*.{js,jsx,mjs,ts,tsx}'];

/**
 * Scope a preset that ships without `files` to one set of globs; entries that only carry `ignores` stay global.
 * @param {import('typescript-eslint').ConfigWithExtends[]} configs
 * @param {string[]} files
 * @returns {import('typescript-eslint').ConfigWithExtends[]}
 */
const scoped = (configs, files) =>
  configs.map((config) =>
    Object.keys(config).length === 1 && config.ignores ? config : { ...config, files },
  );

/**
 * The Next.js preset, loaded only on request: eslint-config-next requires the `next` package at import time,
 * which exists in the workspace once a web app does (ticket 3).
 * @returns {Promise<import('typescript-eslint').ConfigWithExtends[]>}
 */
async function nextConfigs() {
  const [{ default: coreWebVitals }, { default: typescript }] = await Promise.all([
    import('eslint-config-next/core-web-vitals'),
    import('eslint-config-next/typescript'),
  ]);
  return [...scoped(coreWebVitals, WEB_APP_FILES), ...scoped(typescript, WEB_APP_FILES)];
}

/**
 * @param {object} options
 * @param {string} options.tsconfigRootDir the workspace root, so that type-aware rules find every tsconfig
 * @param {boolean} options.nextjs whether a Next.js app exists in `apps/*-web` (requires `next` to be installed)
 * @returns {Promise<import('typescript-eslint').ConfigArray>} ESLint accepts a promise as the flat config export
 */
export async function createConfig({ tsconfigRootDir, nextjs }) {
  return tseslint.config(
    {
      ignores: [
        '**/node_modules/',
        '**/dist/',
        '**/.next/',
        '**/coverage/',
        '**/playwright-report/',
        '**/test-results/',
        '.local/',
      ],
    },
    {
      files: SOURCE_FILES,
      languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
      linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    // TypeScript with type information. projectService picks the nearest tsconfig.json for each file.
    ...tseslint.configs.recommendedTypeChecked.map((config) => ({
      ...config,
      files: TYPESCRIPT_FILES,
    })),
    {
      files: TYPESCRIPT_FILES,
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    // Import hygiene and ordering for every file; workspace packages resolve through their tsconfig.
    {
      files: SOURCE_FILES,
      plugins: { 'import-x': importX },
      settings: {
        'import-x/resolver-next': [
          createTypeScriptImportResolver({
            alwaysTryTypes: true,
            project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'],
            noWarnOnMultipleProjects: true,
          }),
        ],
      },
      rules: {
        ...importX.flatConfigs.recommended.rules,
        ...importX.flatConfigs.typescript.rules,
        'import-x/first': 'error',
        'import-x/newline-after-import': 'error',
        'import-x/no-duplicates': 'error',
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
            pathGroups: [{ pattern: '@auth-stack/**', group: 'internal', position: 'before' }],
            pathGroupsExcludedImportTypes: ['type'],
            'newlines-between': 'always',
            alphabetize: { order: 'asc', caseInsensitive: true },
          },
        ],
      },
    },
    // Next.js rules apply to the web apps only; the Fastify apps and the packages never see React or the DOM.
    ...(nextjs ? await nextConfigs() : []),
    // Tests import describe/it/expect from @jest/globals, so no test globals are declared.
    {
      files: ['**/*.test.{ts,tsx}'],
      rules: { '@typescript-eslint/no-floating-promises': 'off' },
    },
    prettier,
  );
}
