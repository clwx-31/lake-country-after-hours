import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the release runs from any local static server path.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    assetsInlineLimit: 0,
  },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as never);
