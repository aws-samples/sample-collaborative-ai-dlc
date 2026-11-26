import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import App from './App.tsx';
import { applyBranding } from './lib/branding';
import { queryClient } from './lib/queryClient';

// Optional deployment branding (title, favicon, brand stylesheet) before the
// first paint, so the default theme never flashes.
await applyBranding();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
