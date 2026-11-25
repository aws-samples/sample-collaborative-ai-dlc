import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/query';
import { MemoryRouter, Route, Routes } from 'react-router';

import NotFound from './NotFound';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<p>My work page</p>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotFound', () => {
  it('says the page does not exist and offers one way back to My work', () => {
    renderAt('/this-does-not-exist');

    expect(
      screen.getByRole('heading', { level: 1, name: "This page doesn't exist" }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to My work' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('shows the requested address so a mistyped link can be spotted', () => {
    renderAt('/space/typo/intents');

    expect(screen.getByText('/space/typo/intents')).toBeInTheDocument();
  });
});
