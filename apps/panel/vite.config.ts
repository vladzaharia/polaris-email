import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Vite v8 + Tailwind v4 (`@tailwindcss/vite` replaces the legacy postcss
// pipeline). React 19 via @vitejs/plugin-react v6.
//
// Phase 6e.1 — `manualChunks` splits the two heaviest vendor surfaces into
// their own chunks so the main entry stays small and Radix/TanStack updates
// don't bust the cache on every panel deploy. Routes are already lazy via
// `lazyRouteComponent`, so this is the last big-ticket cache-friendliness
// improvement.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, 'src/client'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@tanstack/')) return 'vendor-tanstack';
            if (id.includes('@radix-ui/')) return 'vendor-radix';
            if (id.includes('lucide-react')) return 'vendor-lucide';
          }
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
});
