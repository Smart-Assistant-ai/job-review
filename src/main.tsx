import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* BASE_URL is "/" or the sub-folder set with VITE_BASE_PATH at build time. */}
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/+$/, '')}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
