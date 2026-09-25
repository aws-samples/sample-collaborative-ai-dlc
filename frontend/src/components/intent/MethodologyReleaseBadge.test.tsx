import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MethodologyReleaseBadge } from './MethodologyReleaseBadge';

const pin = {
  releaseId: 'aidlc:abc1234def5678',
  sourceSha: 'abc1234def5678',
  importerRevision: 1,
  closureDigest: 'f'.repeat(64),
};

describe('MethodologyReleaseBadge', () => {
  it('renders nothing for an unpinned (legacy) intent', () => {
    const { container } = render(<MethodologyReleaseBadge release={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the upstream version when present', () => {
    render(<MethodologyReleaseBadge release={{ ...pin, upstreamVersion: '1.2.0' }} />);
    expect(screen.getByTestId('methodology-release-badge')).toHaveTextContent('AI-DLC 1.2.0');
  });

  it('falls back to the short source sha (the execution pin carries no version)', () => {
    render(<MethodologyReleaseBadge release={pin} />);
    expect(screen.getByTestId('methodology-release-badge')).toHaveTextContent('AI-DLC abc1234');
  });
});
