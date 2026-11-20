import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Build targets (selected with --mode):
 *   production (default) → dist/            hosted web app / installable PWA
 *   extension            → dist-extension/  Chrome MV3 extension (load unpacked or zip)
 *   electron             → dist-electron/   renderer for the macOS desktop app
 */
export default defineConfig(({ mode }) => {
  const packaged = mode === 'extension' || mode === 'electron';

  // The PWA manifest link is meaningless (and 404s) inside the extension / desktop app.
  const stripPwa: Plugin = {
    name: 'strip-pwa-manifest',
    transformIndexHtml: (html) => {
      if (!packaged) return html;
      html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
      if (mode === 'electron') {
        html = html.replace(
          '<meta charset="UTF-8" />',
          `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:" />`,
        );
      }
      return html;
    },
  };

  return {
    base: packaged ? './' : '/',
    plugins: [react(), tailwindcss(), stripPwa],
    worker: { format: 'es' },
    publicDir: mode === 'extension' ? 'platforms/extension' : mode === 'electron' ? 'platforms/electron-public' : 'public',
    build: {
      outDir: mode === 'extension' ? 'dist-extension' : mode === 'electron' ? 'dist-electron' : 'dist',
      emptyOutDir: true,
      // The MP4 converter (mediabunny) is a lazily-loaded chunk, only fetched when converting.
      chunkSizeWarningLimit: 1000,
    },
  };
});
