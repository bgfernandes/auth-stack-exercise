// Root ESLint flat config: the rules live in @auth-stack/config so apps and packages stay preset-free.
// `nextjs` turns on eslint-config-next for apps/*-web (on since ticket 3 added the first web app).
import { createConfig } from '@auth-stack/config/eslint';

export default createConfig({ tsconfigRootDir: import.meta.dirname, nextjs: true });
