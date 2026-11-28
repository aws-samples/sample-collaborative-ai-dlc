import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Rocket } from 'lucide-react';
import { Alert, AlertDescription } from './alert';

describe('Alert', () => {
  it('defaults to a neutral status region with an h2 title, body and action', () => {
    render(
      <Alert title="Delivery failed" action={<button type="button">Retry</button>}>
        <AlertDescription>The pull request could not be opened.</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole('status');
    expect(alert).toHaveAttribute('data-tone', 'neutral');
    expect(alert).toHaveTextContent('The pull request could not be opened.');
    // P2-4 (a11y audit): the title used to be a fixed h5 straight under the page h1.
    expect(screen.getByRole('heading', { level: 2, name: 'Delivery failed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it.each([
    ['info', 'border-primary/30', 'text-primary'],
    ['success', 'border-agent-success/30', 'text-agent-success-fg'],
    ['warning', 'border-warning/30', 'text-warning-fg'],
    ['danger', 'border-destructive/30', 'text-destructive'],
    ['neutral', 'border-border', 'text-muted-foreground'],
  ] as const)('tone %s uses token-based classes and a decorative icon', (tone, border, icon) => {
    render(
      <Alert tone={tone} icon={<Rocket data-testid="icon" />}>
        Body
      </Alert>,
    );
    expect(screen.getByText('Body').closest('[data-tone]')).toHaveClass(border);
    const iconWrap = screen.getByTestId('icon').parentElement;
    expect(iconWrap).toHaveClass(icon);
    expect(iconWrap).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['danger', true, 'alert'],
    ['warning', true, 'alert'],
    ['danger', false, 'status'],
    ['info', true, 'status'],
    ['success', true, 'status'],
    ['neutral', true, 'status'],
  ] as const)('%s (live: %s) is role="%s"', (tone, live, role) => {
    render(
      <Alert tone={tone} live={live}>
        Body
      </Alert>,
    );
    expect(screen.getByRole(role)).toHaveTextContent('Body');
  });
});
