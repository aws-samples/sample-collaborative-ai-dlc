import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg role="img" aria-label="diagram"><text>diagram</text></svg>',
      bindFunctions: vi.fn(),
    })),
  },
}));

describe('ArtifactMarkdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Mermaid code fences as diagrams', async () => {
    render(
      <ArtifactMarkdown content={`Before\n\n\`\`\`mermaid\ngraph TD\n  A-->B\n\`\`\`\n\nAfter`} />,
    );

    await waitFor(() => expect(screen.getByRole('img', { name: 'diagram' })).toBeInTheDocument());
    expect(mermaid.render).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      'graph TD\n  A-->B',
    );
  });

  it('keeps non-Mermaid code fences as code blocks', () => {
    render(<ArtifactMarkdown content={`\`\`\`ts\nconst answer = 42;\n\`\`\``} />);

    expect(screen.getByText('const answer = 42;')).toBeInTheDocument();
    expect(mermaid.render).not.toHaveBeenCalled();
  });
});
