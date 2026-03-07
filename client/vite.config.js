import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:3001';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': {
        target: wsTarget,
        ws: true
      }
    }
  }
});
