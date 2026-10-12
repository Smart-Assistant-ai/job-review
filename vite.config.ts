import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { devProxyTarget, normalizeBasePath } from './shared/api-root.ts';

// The React app is built into dist/client. It can be served by the Node server
// or uploaded as static files to a sub-folder of an existing site.
//
//   VITE_BASE_PATH     sub-folder the site is served from, e.g. "job-applicants-review"
//   VITE_BASE_API_URL  where the backend is, e.g. "http://dev.example.com:8799"
//
// VITE_BASE_API_URL is used in two ways:
//   - In a production build, the site calls that address directly.
//   - With `npm run dev:client` (frontend only, on your own machine), this dev
//     server forwards API calls to it. The browser only ever talks to localhost,
//     so sign-in works and the backend needs no special settings for local use.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const base = normalizeBasePath(env.VITE_BASE_PATH);
  const backend = devProxyTarget(env.VITE_BASE_API_URL);

  return {
    base,
    plugins: [react(), tailwindcss()],
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
    },
    server: backend
      ? {
          proxy: {
            [`${base.replace(/\/$/, '')}/api`]: {
              target: backend,
              changeOrigin: true,
              configure(proxy) {
                // The backend refuses changes that a browser reports as coming from
                // another website. These calls come from this dev server, not a website.
                proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
                // The backend marks its sign-in cookie HTTPS-only. Localhost is plain HTTP.
                proxy.on('proxyRes', (proxyRes) => {
                  const cookies = proxyRes.headers['set-cookie'];
                  if (cookies) proxyRes.headers['set-cookie'] = cookies.map((c) => c.replace(/;\s*Secure/gi, ''));
                });
              },
            },
          },
        }
      : undefined,
  };
});
