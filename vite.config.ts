import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { normalizeBasePath } from './shared/api-root.ts';

// The React app is built into dist/client. It can be served by the Node server
// or uploaded as static files to a sub-folder of an existing site.
//
//   VITE_BASE_PATH     sub-folder the site is served from, e.g. "job-applicants-review"
//   VITE_BASE_API_URL  where the browser reaches the backend, e.g. "dev.example.com:8799"
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: normalizeBasePath(env.VITE_BASE_PATH),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
  };
});
