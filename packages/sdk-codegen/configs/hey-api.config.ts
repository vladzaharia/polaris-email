// Hey API config. Produces the type-only generated surface for `@polaris/sdk`
// in `packages/sdk-node/src/generated/`. The TanStack Query plugin emits hook
// wrappers into `react.ts`. `client-fetch` is the runtime — the hand-written
// `Polaris` class in `src/index.ts` plugs into it via `authBuilder`.
import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  input: '../../openapi/polaris-email.yaml',
  output: {
    path: '../sdk-node/src/generated',
    format: 'prettier',
    lint: false,
  },
  plugins: [
    '@hey-api/typescript',
    '@hey-api/sdk',
    {
      name: '@hey-api/client-fetch',
      runtimeConfigPath: '../sdk-node/src/index.ts',
    },
    {
      name: '@tanstack/react-query',
      // Emitted into sdk-node/src/react.ts via the generator's output map.
    },
  ],
});
