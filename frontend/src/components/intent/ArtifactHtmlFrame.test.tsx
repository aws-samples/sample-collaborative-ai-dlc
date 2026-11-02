import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isHtmlDocument, withArtifactCsp } from '@/components/intent/ArtifactHtmlFrame';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const PAGE = '<!DOCTYPE html><html><body><h1>Wireframes</h1></body></html>';

describe('ArtifactHtmlFrame', () => {
  it.each([
    ['<!DOCTYPE html><html></html>', true],
    ['  \n<!doctype html>\n<html lang="en"></html>', true],
    ['<!-- generated -->\n<html><body></body></html>', true],
    ['# Requirements\n\n<details>inline HTML in markdown</details>', false],
    ['Text that mentions <html> later', false],
    ['<htmlish>', false],
  ])('detects a full HTML document: %j -> %s', (content, expected) => {
    expect(isHtmlDocument(content)).toBe(expected);
  });

  it('renders an HTML artifact in a script-less sandbox that cannot reach the network', () => {
    render(<ArtifactMarkdown content={PAGE} />);

    const frame = screen.getByTitle('HTML artifact');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    const srcdoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toBe(withArtifactCsp(PAGE));
    expect(srcdoc).toMatch(
      /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*">/,
    );
    expect(srcdoc).not.toMatch(/script-src|https?:/);
  });
});
