import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    // Only VITE_-prefixed variables are read here; nothing secret is
    // injected into the browser bundle by this config.
    const env = loadEnv(mode, '.', 'VITE_');
    return {
      // Set VITE_BASE_PATH (for example "/unisport/") to deploy under a
      // non-root path. Static assets are resolved relative to it via
      // import.meta.env.BASE_URL.
      base: env.VITE_BASE_PATH || '/',
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
