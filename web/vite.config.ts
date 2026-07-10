import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const shared = fileURLToPath(new URL('../packages/shared/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Consume the domain package as TypeScript source so the browser and the
      // NestJS server provably run the same fare math, FSM and road graph.
      { find: '@tylo/shared', replacement: shared + '/index.ts' },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: {
    // Bind IPv4 explicitly: on Windows the default binds ::1 only, and
    // `localhost` resolves to 127.0.0.1 first — the page then refuses.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true, changeOrigin: true },
    },
  },
});
