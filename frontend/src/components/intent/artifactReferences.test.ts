import { describe, expect, it } from 'vitest';
import {
  buildReferenceDefinitions,
  cellReferenceId,
  definitionsInArtifact,
  leadingReferenceId,
  referenceAnchor,
  referenceIdColumn,
} from '@/components/intent/artifactReferences';

const units = {
  id: 'unit-of-work',
  title: 'Units of work',
  createdAt: '2026-11-01T10:00:00.000Z',
  content: [
    '# Units of work',
    '',
    '| Unit ID | Directory | Kind |',
    '|---|---|---|',
    '| U1 | u1-auth | service |',
    '| **U26** | u26-reporting | library |',
    '| U8b | u8b-ports | library |',
  ].join('\n'),
};

const stories = {
  id: 'stories',
  title: 'User stories',
  createdAt: '2026-11-01T09:00:00.000Z',
  content: [
    '## US6.11 Export a monthly report',
    '',
    'As an operator, I want …',
    '',
    '### US17.9: Audit log view',
    '',
    '- **OQ-01** — Which identity provider?',
    '- **CR-10**: apply carried conditions',
    '',
    '```text',
    '## US99.1 inside a code block',
    '| U99 | not a table |',
    '```',
  ].join('\n'),
};

const storyMap = {
  id: 'unit-of-work-story-map',
  title: 'Story map',
  createdAt: '2026-11-01T11:00:00.000Z',
  content: ['| Story | Unit |', '|---|---|', '| US6.11 | U18 |', '| US17.9 | U15 |'].join('\n'),
};

describe('identifier detection', () => {
  it('reads a whole-cell identifier, ignoring emphasis and code ticks', () => {
    expect(cellReferenceId('**U26**')).toBe('U26');
    expect(cellReferenceId('`US6.11`')).toBe('US6.11');
    expect(cellReferenceId('CR-10')).toBe('CR-10');
    expect(cellReferenceId('U26 and U27')).toBeNull();
    expect(cellReferenceId('service')).toBeNull();
    expect(cellReferenceId('42')).toBeNull();
  });

  it('reads the identifier a heading or label starts with', () => {
    expect(leadingReferenceId('US6.11 Export a monthly report')).toBe('US6.11');
    expect(leadingReferenceId('US17.9: Audit log view')).toBe('US17.9');
    expect(leadingReferenceId('OQ-01 — Which provider?')).toBe('OQ-01');
    expect(leadingReferenceId('Overview of US6.11')).toBeNull();
    expect(leadingReferenceId('U26abc')).toBeNull();
  });

  it('uses the column headed as an identifier, else the first', () => {
    expect(referenceIdColumn(['Unit ID', 'Directory'])).toEqual({ column: 0, explicit: true });
    expect(referenceIdColumn(['Severity', 'Ref', 'Finding'])).toEqual({
      column: 1,
      explicit: true,
    });
    expect(referenceIdColumn(['Story', 'Unit'])).toEqual({ column: 0, explicit: false });
  });
});

describe('definitionsInArtifact', () => {
  it('finds headings, table rows and bold-led list items, outside code blocks', () => {
    expect(definitionsInArtifact(stories)).toEqual([
      { id: 'US6.11', kind: 'heading' },
      { id: 'US17.9', kind: 'heading' },
      { id: 'OQ-01', kind: 'list' },
      { id: 'CR-10', kind: 'list' },
    ]);
    expect(definitionsInArtifact(units).map((d) => d.id)).toEqual(['U1', 'U26', 'U8b']);
  });

  it('reads GFM tables with or without outer pipes', () => {
    const borderless = {
      id: 'units',
      title: 'Units',
      content: [
        'Unit ID | Name',
        '--- | ---',
        'U1 | Alpha',
        'U2 | Beta',
        '',
        'Not part of the table: U9',
      ].join('\n'),
    };
    expect(definitionsInArtifact(borderless).map((d) => d.id)).toEqual(['U1', 'U2']);
  });

  it('does not take a thematic break or a pipe-less line for a table', () => {
    const prose = {
      id: 'notes',
      title: 'Notes',
      content: ['U1 and U2', '---', '', 'A | B', 'not a delimiter'].join('\n'),
    };
    expect(definitionsInArtifact(prose)).toEqual([]);
  });

  it('ends a table where any other block interrupts it, as GFM does', () => {
    const table = 'Unit ID | Name\n--- | ---\nU1 | Alpha\n';
    const after = (tail: string) =>
      definitionsInArtifact({ id: 'units', title: 'Units', content: table + tail });

    // Indented code, a quote and raw HTML end the table and define nothing.
    expect(after('    U9 | Code')).toEqual([{ id: 'U1', kind: 'table' }]);
    expect(after('> U9 | Quoted')).toEqual([{ id: 'U1', kind: 'table' }]);
    expect(after('<div>U9 | Html</div>')).toEqual([{ id: 'U1', kind: 'table' }]);
    // A bold-led list item after it is a list definition, not a row.
    expect(after('- **U2** — Beta')).toEqual([
      { id: 'U1', kind: 'table' },
      { id: 'U2', kind: 'list' },
    ]);
    // A row without outer pipes still continues the table.
    expect(after('U2 | Beta').map((d) => d.kind)).toEqual(['table', 'table']);
  });

  it('ignores ordinary technical tokens that nothing corroborates', () => {
    const services = {
      id: 'design',
      title: 'Design',
      content: [
        '## Q3 Planning',
        '',
        '### SHA256 checksums',
        '',
        '| Service | Purpose |',
        '|---|---|',
        '| S3 | storage |',
        '| EC2 | compute |',
        '',
        '- **H2** — embedded database',
      ].join('\n'),
    };
    expect(definitionsInArtifact(services)).toEqual([]);
  });

  it('accepts a plain token in a column headed as an identifier, or with siblings', () => {
    const headed = {
      id: 'units',
      title: 'Units',
      content: '| Unit ID | Directory |\n|---|---|\n| U1 | u1-auth |',
    };
    const siblings = {
      id: 'risks',
      title: 'Risks',
      content: '| Risk | Note |\n|---|---|\n| R1 | a |\n| R2 | b |\n| S3 | c |',
    };
    expect(definitionsInArtifact(headed).map((d) => d.id)).toEqual(['U1']);
    expect(definitionsInArtifact(siblings).map((d) => d.id)).toEqual(['R1', 'R2']);
  });
});

describe('buildReferenceDefinitions', () => {
  it('prefers a heading over a table row, then the earlier document', () => {
    const index = buildReferenceDefinitions([storyMap, units, stories]);

    // The story map repeats US6.11 in a table; the stories document's heading wins.
    expect(index.get('US6.11')).toMatchObject({ artifactId: 'stories', kind: 'heading' });
    expect(index.get('U26')).toMatchObject({
      artifactId: 'unit-of-work',
      artifactTitle: 'Units of work',
      anchor: referenceAnchor('unit-of-work', 'U26'),
    });
    // The story map only references U18, in its second column.
    expect(index.has('U18')).toBe(false);
  });

  it('returns the same index for the same artifacts array', () => {
    const artifacts = [units];
    expect(buildReferenceDefinitions(artifacts)).toBe(buildReferenceDefinitions(artifacts));
  });
});
