// Root ESLint flat config: the rules live in @auth-stack/config so apps and packages stay preset-free.
// `nextjs` turns on eslint-config-next for apps/*-web; it is switched on by the ticket that adds the first web app.
import { createConfig } from '@auth-stack/config/eslint';

export default createConfig({ tsconfigRootDir: import.meta.dirname, nextjs: false });
