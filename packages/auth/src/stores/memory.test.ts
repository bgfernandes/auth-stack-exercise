import { describeSessionStoreContract } from '../session-store.contract';

import { createMemorySessionStore } from './memory';

describeSessionStoreContract('memory', (options) =>
  Promise.resolve({ store: createMemorySessionStore(options), close: () => Promise.resolve() }),
);
