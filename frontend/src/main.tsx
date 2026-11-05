import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { applyBranding } from './lib/branding';

// Optional deployment branding (title, favicon, brand stylesheet) before the
// first paint, so the default theme never flashes.
await applyBranding();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
