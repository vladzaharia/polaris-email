import { defineConfig } from 'vitest/config';
// Note: panel tests run in `node`. We don't have jsdom/RTL installed, so
// component tests assert on the component's public surface (props, callbacks,
// derived state) and on `react-dom/server` SSR output, not on a mounted DOM.
// The esbuild jsx config below matches `tsconfig.client.json` (automatic
// runtime) so .tsx test files don't need to import React explicitly.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
