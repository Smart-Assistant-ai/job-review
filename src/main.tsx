import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
// Bundled with the app, so no font is fetched from another site.
import '@fontsource-variable/inter';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* BASE_URL is "/" or the sub-folder set with VITE_BASE_PATH at build time. */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '')}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
