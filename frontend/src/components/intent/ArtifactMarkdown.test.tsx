import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import mermaid from 'mermaid';
import { ArtifactMarkdown, PreviewReferenceText } from '@/components/intent/ArtifactMarkdown';

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

  it('matches ids written with dots or underscores to their slugs', () => {
    const onOpenItem = vi.fn();
    render(
      <ArtifactMarkdown
        content="Covers FR2.4/FR2.12, NFR_1 and dec-session-tokens. Not FR2.4.1 or FR2.1."
        derivedItems={[
          { id: 'fr-a', slug: 'fr2-4', label: 'Sign in' },
          { id: 'fr-b', slug: 'fr2-12', label: 'Sign out' },
          { id: 'nfr', slug: 'nfr-1', label: 'Fast' },
          { id: 'dec', slug: 'dec-session-tokens', label: 'Use short-lived session tokens' },
        ]}
        onOpenItem={onOpenItem}
      />,
    );

    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Sign in',
      'Sign out',
      'Fast',
      'Use short-lived session tokens',
    ]);
  });

  it('keeps the referencing text when asked, with the title on hover', () => {
    render(
      <ArtifactMarkdown
        content="See FR2.4."
        derivedItems={[{ id: 'fr-a', slug: 'fr2-4', label: 'Sign in' }]}
        preserveReferenceText
      />,
    );

    const link = screen.getByRole('link', { name: 'FR2.4' });
    expect(link).toHaveAttribute('href', '#item-fr-a');
    expect(link).toHaveAttribute('title', 'Sign in');
  });
});

describe('PreviewReferenceText', () => {
  it('links references in plain text without reaching enclosing click handlers', () => {
    const onOpenItem = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <PreviewReferenceText
          text="Keep **dec-session-tokens** as written"
          derivedItems={[
            { id: 'dec', slug: 'dec-session-tokens', label: 'Use short-lived session tokens' },
          ]}
          onOpenItem={onOpenItem}
          preserveReferenceText
          stopLinkPropagation
        />
      </div>,
    );

    screen.getByRole('link', { name: 'dec-session-tokens' }).click();
    expect(onOpenItem).toHaveBeenCalledWith('dec');
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByText(/as written/).textContent).toBe(
      'Keep **dec-session-tokens** as written',
    );
  });
});

describe('ArtifactMarkdown — identifiers defined in documents', () => {
  const units = {
    id: 'unit-of-work',
    title: 'Units of work',
    content: '| Unit ID | Directory |\n|---|---|\n| U1 | u1-auth |\n| U26 | u26-reporting |',
  };
  const stories = {
    id: 'stories',
    title: 'User stories',
    content: '## US6.11 Export a monthly report\n\nDepends on U1.',
  };

  it('links an identifier to the row that defines it, keeping its text', () => {
    const onOpenArtifact = vi.fn();
    render(
      <ArtifactMarkdown
        content="U26 depends on U8, and US6.11 goes to U18."
        artifacts={[units, stories]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    const unit = screen.getByRole('link', { name: 'U26' });
    expect(unit).toHaveAttribute('href', '#artifact-unit-of-work/ref-unit-of-work--u26');
    expect(unit).toHaveAttribute('title', 'Units of work');
    unit.click();
    expect(onOpenArtifact).toHaveBeenCalledWith('unit-of-work', 'ref-unit-of-work--u26');

    expect(screen.getByRole('link', { name: 'US6.11' })).toHaveAttribute(
      'href',
      '#artifact-stories/ref-stories--us6-11',
    );
    // Neither U8 nor U18 is defined anywhere.
    expect(screen.queryByRole('link', { name: 'U8' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'U18' })).not.toBeInTheDocument();
  });

  it('gives definitions their anchor in their own document and does not link them', () => {
    const { container } = render(
      <ArtifactMarkdown content={units.content} artifactId="unit-of-work" artifacts={[units]} />,
    );

    const row = container.querySelector('#ref-unit-of-work--u26');
    expect(row?.tagName).toBe('TR');
    expect(row?.textContent).toContain('u26-reporting');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('anchors a defining heading and still links other identifiers in the document', () => {
    const { container } = render(
      <ArtifactMarkdown
        content={stories.content}
        artifactId="stories"
        artifacts={[units, stories]}
      />,
    );

    expect(container.querySelector('#ref-stories--us6-11')?.tagName).toBe('H2');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['U1']);
  });

  it('prefers a derived item over a document definition of the same identifier', () => {
    render(
      <ArtifactMarkdown
        content="See US6.11."
        artifacts={[stories]}
        derivedItems={[{ id: 'story-node', slug: 'us6-11', label: 'Export a monthly report' }]}
        preserveReferenceText
      />,
    );

    expect(screen.getByRole('link', { name: 'US6.11' })).toHaveAttribute(
      'href',
      '#item-story-node',
    );
  });

  it('links a copy of a definition to the document that defines it', () => {
    const storyMap = {
      id: 'story-map',
      title: 'Story map',
      content: '| Story | Unit |\n|---|---|\n| US6.11 | U26 |\n| US6.12 | U26 |',
    };
    const { container } = render(
      <ArtifactMarkdown
        content={storyMap.content}
        artifactId="story-map"
        artifacts={[units, stories, storyMap]}
      />,
    );

    // The stories heading defines US6.11, so the story map's copy links there,
    // but its row still carries its own anchor.
    expect(screen.getByRole('link', { name: 'US6.11' })).toHaveAttribute(
      'href',
      '#artifact-stories/ref-stories--us6-11',
    );
    expect(container.querySelector('#ref-story-map--us6-11')?.tagName).toBe('TR');
    // The story map is where US6.12 is defined, so it isn't a link to itself.
    expect(screen.queryByRole('link', { name: 'US6.12' })).not.toBeInTheDocument();
    expect(container.querySelector('#ref-story-map--us6-12')?.tagName).toBe('TR');
  });

  it('still links other references in a heading that defines an identifier', () => {
    const doc = {
      id: 'stories',
      title: 'User stories',
      content: '## US6.11 Covers FR2.4 and [[requirements]]',
    };
    const { container } = render(
      <ArtifactMarkdown
        content={doc.content}
        artifactId="stories"
        artifacts={[doc, { id: 'requirements', title: 'Requirements' }]}
        derivedItems={[{ id: 'fr-node', slug: 'fr2-4', label: 'Sign in' }]}
        preserveReferenceText
      />,
    );

    const heading = container.querySelector('#ref-stories--us6-11');
    expect(heading?.tagName).toBe('H2');
    expect(heading?.textContent).toBe('US6.11 Covers FR2.4 and Requirements');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'FR2.4',
      'Requirements',
    ]);
  });

  it('keeps links beside the identifier a bold list label defines', () => {
    const doc = {
      id: 'questions',
      title: 'Open questions',
      content: '- **OQ-01 needs FR2.4** — which?',
    };
    const { container } = render(
      <ArtifactMarkdown
        content={doc.content}
        artifactId="questions"
        artifacts={[doc]}
        derivedItems={[{ id: 'fr-node', slug: 'fr2-4', label: 'Sign in' }]}
        preserveReferenceText
      />,
    );

    expect(container.querySelector('#ref-questions--oq-01')?.tagName).toBe('LI');
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['FR2.4']);
  });

  it('anchors and links the rows of a table without outer pipes', () => {
    const borderless = {
      id: 'units',
      title: 'Units',
      content: 'Unit ID | Name\n--- | ---\nU1 | Alpha\nU2 | Beta',
    };
    const { container } = render(
      <ArtifactMarkdown content={borderless.content} artifactId="units" artifacts={[borderless]} />,
    );
    expect(container.querySelector('#ref-units--u2')?.tagName).toBe('TR');

    render(<ArtifactMarkdown content="See U2." artifacts={[borderless]} />);
    expect(screen.getByRole('link', { name: 'U2' })).toHaveAttribute(
      'href',
      '#artifact-units/ref-units--u2',
    );
  });
});
