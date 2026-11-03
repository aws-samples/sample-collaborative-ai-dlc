import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

// Only the routing table is under test: providers, guards and the shell are
// pass-throughs, and the two pages are markers.
vi.mock('./contexts/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/theme/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router');
  return { AppShell: () => <Outlet /> };
});
vi.mock('./pages/Login', () => ({ default: () => null }));
vi.mock('./pages/AuthCallback', () => ({ default: () => null }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div data-testid="dashboard-page" /> }));
vi.mock('./pages/MyWork', () => ({ default: () => <div data-testid="my-work-page" /> }));

import App from './App';

describe('App routes', () => {
  it('still lands on the Spaces dashboard at /', async () => {
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(await screen.findByTestId('dashboard-page')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/dashboard');
  });

  it('serves My work at /my-work', async () => {
    window.history.pushState({}, '', '/my-work');
    render(<App />);
    expect(await screen.findByTestId('my-work-page')).toBeInTheDocument();
  });
});
