// Module augmentation: type `vitest`'s `provide`/`inject` channel for the
// migrations payload passed from Node-side global-setup.ts into worker
// isolates.
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare module 'vitest' {
  export interface ProvidedContext {
    migrations: D1Migration[];
  }
}
