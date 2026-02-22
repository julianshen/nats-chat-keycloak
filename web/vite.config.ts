import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Excalidraw's roughjs dependency requires eval-like constructs internally.
// Vite 6 sets its own strict CSP in dev mode that blocks this.
// This plugin intercepts Vite's CSP header and relaxes the script-src directive.
function relaxCspForExcalidraw(): Plugin {
  return {
    name: 'relax-csp-for-excalidraw',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        const originalSetHeader = res.setHeader.bind(res);
        res.setHeader = (name: string, value: any) => {
          if (name.toLowerCase() === 'content-security-policy') {
            const policy = String(value);
            if (policy.includes('script-src') && !policy.includes("'unsafe-eval'")) {
              value = policy.replace(/script-src\s/, "script-src 'unsafe-eval' ");
            }
          }
          return originalSetHeader(name, value);
        };
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [relaxCspForExcalidraw(), react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
});
