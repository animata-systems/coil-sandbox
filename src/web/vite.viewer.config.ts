/**
 * Vite config for the agent viewer bundle.
 *
 * Builds a single ES module that is loaded from index.html via
 * <script type="module" defer src="/agent-viewer.js"></script>. The bundle
 * registers window.openAgentViewer / window.closeAgentViewer and mounts a
 * React root into #agent-viewer-root on demand.
 *
 * Monaco is *not* bundled — @monaco-editor/react loads it from jsdelivr CDN
 * at runtime (see coil-sandbox/DESIGN.md S-0001 for the integration decision).
 *
 * Output goes directly into src/web/public/ next to index.html so it is served
 * by the existing Express static handler. emptyOutDir is false — we must not
 * wipe index.html and other vanilla assets that already live there.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Prevent Vite from picking up coil-sandbox/index.html as the app entry.
  // We only build a single JS bundle via build.lib.
  appType: 'custom',

  // In library mode Vite does NOT replace process.env.NODE_ENV by default —
  // it assumes the consumer does the substitution. But this bundle IS its
  // own consumer (loaded via a plain <script> tag in vanilla HTML), so
  // React and other `if (process.env.NODE_ENV !== 'production')` checks
  // throw `ReferenceError: process is not defined` in the browser. Force
  // the production constant into the bundle here.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },

  resolve: {
    // Guard against double React copies when coil-ide (git-dep) and the
    // sandbox bundle both resolve react. coil-ide lists react/react-dom as
    // peerDeps (I-0004), so there should only ever be one copy — this makes
    // it explicit.
    dedupe: ['react', 'react-dom'],
  },

  build: {
    outDir: resolve(__dirname, 'public'),
    emptyOutDir: false,
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'viewer/main.tsx'),
      formats: ['es'],
      fileName: () => 'agent-viewer.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (asset) => {
          // Emit the single CSS chunk as agent-viewer.css regardless of the
          // internal Rollup name. index.html links to this exact filename.
          if (asset.name && asset.name.endsWith('.css')) {
            return 'agent-viewer.css';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
