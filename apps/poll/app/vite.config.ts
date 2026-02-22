import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: 'PollApp',
      fileName: () => 'poll-app.js',
    },
  },
});
