import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Production CSP for the file:// renderer. The renderer never talks to the
// network: all backend access goes through the preload bridge to Electron main.
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'aegis-production-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP },
        injectTo: 'head',
      },
    ],
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), productionCsp()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome140',
    // No inline module preload polyfill: it would need 'unsafe-inline'.
    modulePreload: { polyfill: false },
  },
});
