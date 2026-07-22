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

  it('links known wiki references to artifact previews', () => {
    const onOpenArtifact = vi.fn();
    render(
      <ArtifactMarkdown
        content="See [[reverse-engineering-timestamp]] for details."
        artifacts={[
          { id: 'reverse-engineering-timestamp', title: 'Reverse Engineering Timestamp' },
        ]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    const link = screen.getByRole('link', { name: 'Reverse Engineering Timestamp' });
    expect(link).toHaveAttribute('href', '#artifact-reverse-engineering-timestamp');
    link.click();
    expect(onOpenArtifact).toHaveBeenCalledWith('reverse-engineering-timestamp');
  });

  it('links known derived-item slugs in ordinary Markdown text', () => {
    const onOpenItem = vi.fn();
    render(
      <ArtifactMarkdown
        content="Maps to story-upload-screen and req-upload-two-buttons."
        derivedItems={[
          { id: 'story-node', slug: 'story-upload-screen', label: 'Upload screen' },
          { id: 'req-node', slug: 'req-upload-two-buttons', label: 'Two upload buttons' },
        ]}
        onOpenItem={onOpenItem}
      />,
    );

    const storyLink = screen.getByRole('link', { name: 'Upload screen' });
    const requirementLink = screen.getByRole('link', { name: 'Two upload buttons' });
    expect(storyLink).toHaveAttribute('href', '#item-story-node');
    expect(requirementLink).toHaveAttribute('href', '#item-req-node');
    storyLink.click();
    requirementLink.click();
    expect(onOpenItem).toHaveBeenNthCalledWith(1, 'story-node');
    expect(onOpenItem).toHaveBeenNthCalledWith(2, 'req-node');
  });

  it('does not link wiki references or derived-item slugs inside code', () => {
    render(
      <ArtifactMarkdown
        content={'`[[artifact-id]] story-upload-screen`'}
        artifacts={[{ id: 'artifact-id', title: 'Artifact' }]}
        derivedItems={[{ id: 'story-node', slug: 'story-upload-screen', label: 'Upload screen' }]}
      />,
    );

    expect(screen.getByText('[[artifact-id]] story-upload-screen')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
