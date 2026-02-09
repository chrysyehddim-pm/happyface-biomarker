import { defineConfig } from 'vite';

export default defineConfig({
  base: '/happyface-biomarker/',
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  server: {
    port: 5173,
  },
});
