import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBar } from './StatusBar';

describe('StatusBar', () => {
  it('renders the canonical application version and environment', () => {
    render(<StatusBar />);

    expect(screen.getByText('AI-DLC v2.0.0-test | test')).toBeInTheDocument();
  });
});
