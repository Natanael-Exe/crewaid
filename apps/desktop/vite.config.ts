import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Renderer build for the Crewaid Electron client.
 *
 * Outputs to dist/renderer, which src/main.ts loads via loadFile in production
 * and via ELECTRON_START_URL in dev (`pnpm --filter @crewaid/desktop dev`).
 *
 * ⚠️ R1 reminder: everything bundled here is client code. The renderer speaks
 * HTTP/WSS to the orchestrator; it never touches orchestration internals.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    // Electron renderer loads over file:// — relative asset URLs are required.
    assetsDir: 'assets',
    target: 'chrome140',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
