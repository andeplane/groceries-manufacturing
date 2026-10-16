import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), products: resolve(__dirname, 'products.html') },
    },
  },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
