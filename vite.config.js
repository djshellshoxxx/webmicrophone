import { defineConfig } from 'vite';

export default defineConfig({
  base: '/webmicrophone/',
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
});
