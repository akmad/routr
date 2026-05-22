import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The WS endpoint lives under /api/v1/ws — give it the ws: true flag
      // so Vite proxies the WebSocket upgrade too, not just the HTTP request.
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
});
