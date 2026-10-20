import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/v1': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // Pass the phone's IP through so the backend's per-IP limits see real devices.
        xfwd: true,
      },
    },
  },
});
