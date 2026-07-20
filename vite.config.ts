import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        // 127.0.0.1, not localhost: the server binds IPv4 0.0.0.0, and Node may
        // resolve localhost to ::1 first → ECONNREFUSED on every proxied request.
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
        // RegExp key: match only the short-link path (/s, /s/..., /s?...),
        // not /src/* — plain '/s' is prefix-matched by Vite and hijacked
        // /src/main.tsx, blanking the dev server.
        '^/s($|/|\\?)': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
