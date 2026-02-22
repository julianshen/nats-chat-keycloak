import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Vite lib mode extracts CSS to a separate file by default.
// For IIFE Web Components loaded via <script>, we need CSS inlined into the JS.
function cssInlinePlugin(): Plugin {
  return {
    name: 'css-inline',
    apply: 'build',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const cssChunks: string[] = [];
      // Collect and remove CSS assets
      for (const [key, chunk] of Object.entries(bundle)) {
        if (key.endsWith('.css') && chunk.type === 'asset') {
          cssChunks.push(String(chunk.source));
          delete bundle[key];
        }
      }
      if (cssChunks.length === 0) return;
      // Inject CSS into the JS entry
      const cssCode = cssChunks.join('\n');
      const injection = `(function(){var s=document.createElement("style");s.textContent=${JSON.stringify(cssCode)};document.head.appendChild(s)})();\n`;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          chunk.code = injection + chunk.code;
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), cssInlinePlugin()],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: 'WhiteboardApp',
      fileName: () => 'whiteboard-app.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
  },
});
