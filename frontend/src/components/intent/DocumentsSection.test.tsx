import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Accordion } from '@/components/ui/accordion';
import {
  DocumentsSection,
  DOCUMENTS_ACCORDION_VALUE,
  isDocumentArtifact,
} from './DocumentsSection';
import type { IntentArtifact } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';

// DiscussButton pulls a discussions provider it has no need for here — stub it.
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button data-testid="discuss" />,
}));

const LONG = `# Heading\n\n${'Long-form markdown body. '.repeat(40)}`;

const doc = (over: Partial<IntentArtifact> = {}): IntentArtifact => ({
  id: 'a1',
  artifactType: 'requirements',
  title: 'A doc',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-a',
  createdAt: '2026-01-01T00:00:00Z',
  content: LONG,
  ...over,
});

const row = (over: Partial<IntentStageRow> = {}): IntentStageRow => ({
  stageId: 'requirements-analysis',
  phase: '01',
  state: 'SUCCEEDED',
  stageInstanceId: 'si-a',
  unitSlug: null,
  runtimeError: null,
  startedAt: null,
  completedAt: null,
  waitMs: 0,
  parkedAt: null,
  attempt: 0,
  cli: null,
  resolvedModel: null,
  order: 1,
  planned: true,
  ...over,
});

// Canonical phasePath → display name, mimicking IntentContext.phaseNameOf: known
// paths map to a proper name, everything else capitalizes the raw path.
const PHASE_NAMES: Record<string, string> = { '01': 'Inception', '02': 'Construction' };
const phaseNameOf = (path: string) =>
  PHASE_NAMES[path] ?? (path ? path.charAt(0).toUpperCase() + path.slice(1) : path);

const renderSection = (overrides: Partial<Parameters<typeof DocumentsSection>[0]> = {}) =>
  render(
    <Accordion type="multiple" defaultValue={[DOCUMENTS_ACCORDION_VALUE]}>
      <DocumentsSection
        documents={[doc()]}
        stageRows={[row()]}
        phaseNameOf={phaseNameOf}
        getNeighbors={() => []}
        itemsByArtifact={new Map()}
        openArtifactPreview={() => {}}
        {...overrides}
      />
    </Accordion>,
  );

// Read phase headers + document titles in DOM order to assert the full sequence.
const orderedLabels = (labels: string[]) =>
  labels
    .map((t) => ({ t, el: screen.getByText(t) }))
    .toSorted((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )
    .map((p) => p.t);

describe('isDocumentArtifact', () => {
  it('treats long markdown as a document and short markers as not', () => {
    expect(isDocumentArtifact(doc())).toBe(true);
    expect(
      isDocumentArtifact(
        doc({ artifactType: 'practices-discovery-timestamp', content: 'ts: now' }),
      ),
    ).toBe(false);
    // Type name alone can qualify it (document-ish type) even when short.
    expect(isDocumentArtifact(doc({ artifactType: 'research-report', content: 'x' }))).toBe(true);
  });
});

describe('DocumentsSection', () => {
  it('renders nothing without documents', () => {
    const { container } = renderSection({ documents: [] });
    expect(screen.queryByText('Documents')).not.toBeInTheDocument();
    expect(container.querySelector('[id^="artifact-"]')).toBeNull();
  });

  it('orders phase (latest first) → stage order → date desc', () => {
    renderSection({
      documents: [
        doc({
          id: 'ic',
          title: 'Doc IC',
          createdByStageInstanceId: 'si-ic',
          createdAt: '2026-01-01T10:00:00Z',
        }),
        // code-gen (order 4) produced EARLIER than domain-entities (order 3):
        // plan order must still put code-gen above domain-entities.
        doc({
          id: 'cg',
          title: 'Doc CG',
          createdByStageInstanceId: 'si-cg',
          createdAt: '2026-01-02T08:00:00Z',
        }),
        doc({
          id: 'de',
          title: 'Doc DE',
          createdByStageInstanceId: 'si-de',
          createdAt: '2026-01-02T20:00:00Z',
        }),
        doc({
          id: 'ra-old',
          title: 'Doc RA Old',
          createdByStageInstanceId: 'si-ra',
          createdAt: '2026-01-01T11:00:00Z',
        }),
        doc({
          id: 'ra-new',
          title: 'Doc RA New',
          createdByStageInstanceId: 'si-ra',
          createdAt: '2026-01-01T18:00:00Z',
        }),
      ],
      stageRows: [
        row({ stageId: 'intent-capture', stageInstanceId: 'si-ic', phase: '01', order: 1 }),
        row({ stageId: 'requirements-analysis', stageInstanceId: 'si-ra', phase: '01', order: 2 }),
        row({ stageId: 'domain-entities', stageInstanceId: 'si-de', phase: '02', order: 3 }),
        row({ stageId: 'code-gen', stageInstanceId: 'si-cg', phase: '02', order: 4 }),
      ],
    });

    expect(
      orderedLabels([
        'Construction',
        'Inception',
        'Doc CG',
        'Doc DE',
        'Doc IC',
        'Doc RA New',
        'Doc RA Old',
      ]),
    ).toEqual([
      'Construction', //  latest phase first
      'Doc CG', //        stage order 4 (above order 3 despite earlier date)
      'Doc DE', //        stage order 3
      'Inception', //     earlier phase second
      'Doc RA New', //    stage order 2, newest of its stage first
      'Doc RA Old', //    stage order 2, older second
      'Doc IC', //        stage order 1 last
    ]);
  });

  it('shows the humanized stage badge', () => {
    renderSection({
      documents: [doc({ id: 'a', createdByStageInstanceId: 'si-a' })],
      stageRows: [row({ stageId: 'requirements-analysis', stageInstanceId: 'si-a' })],
    });
    expect(screen.getByText('Requirements Analysis')).toBeInTheDocument();
  });

  it('detects and strips the common suffix (dash and parenthetical) for display only', () => {
    renderSection({
      // "Plant Identifier MVP" is NOT the intent title — it's an agent-generated
      // product/scope name repeated across the doc set. Detected by recurrence.
      documents: [
        doc({ id: 'd1', title: 'Build and Test Results — Plant Identifier MVP' }),
        doc({ id: 'd2', title: 'Code Summary — Infrastructure (Plant Identifier MVP)' }),
        doc({ id: 'd3', title: 'Build Instructions — Plant Identifier MVP' }),
      ],
    });
    // Dash-form suffix removed entirely.
    expect(screen.getByText('Build and Test Results')).toBeInTheDocument();
    expect(screen.getByText('Build Instructions')).toBeInTheDocument();
    // Parenthetical-form removed, but the meaningful "— Infrastructure" stays.
    expect(screen.getByText('Code Summary — Infrastructure')).toBeInTheDocument();
    expect(
      screen.queryByText('Build and Test Results — Plant Identifier MVP'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('Code Summary — Infrastructure (Plant Identifier MVP)'),
    ).not.toBeInTheDocument();
  });

  it('strips nothing when no trailing suffix recurs across the set', () => {
    renderSection({
      documents: [
        doc({ id: 'd1', title: 'Requirements — Alpha' }),
        doc({ id: 'd2', title: 'Design — Beta' }),
      ],
    });
    // Each dash tail is unique → not junk → left intact.
    expect(screen.getByText('Requirements — Alpha')).toBeInTheDocument();
    expect(screen.getByText('Design — Beta')).toBeInTheDocument();
  });

  it('drops unresolved-phase documents into an "Other" bucket', () => {
    renderSection({
      documents: [
        doc({ id: 'orphan', title: 'Orphan Doc', createdByStageInstanceId: 'si-missing' }),
        doc({ id: 'ok', title: 'Placed Doc', createdByStageInstanceId: 'si-a' }),
      ],
      // si-missing is absent from stageRows → unresolved.
      stageRows: [row({ stageId: 'requirements-analysis', stageInstanceId: 'si-a', phase: '01' })],
    });
    expect(screen.getByText('Inception')).toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
    // "Other" sorts last, after the resolved phase.
    expect(orderedLabels(['Inception', 'Other'])).toEqual(['Inception', 'Other']);
  });

  it('keeps two distinct unmapped phases in separate buckets', () => {
    renderSection({
      documents: [
        doc({ id: 'x', title: 'Doc X', createdByStageInstanceId: 'si-x' }),
        doc({ id: 'y', title: 'Doc Y', createdByStageInstanceId: 'si-y' }),
      ],
      // Two present-but-unmapped phase paths: distinct keys → distinct buckets,
      // each labeled via phaseNameOf's capitalized fallback (NOT collapsed).
      stageRows: [
        row({ stageId: 's-x', stageInstanceId: 'si-x', phase: 'alpha' }),
        row({ stageId: 's-y', stageInstanceId: 'si-y', phase: 'beta' }),
      ],
    });
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Other')).not.toBeInTheDocument();
  });

  it('adds unit sub-headers when a phase spans 2+ units, with common runs positioned by date', () => {
    // One phase (Construction), stage order: units (order 3) then a common
    // build-and-test step (order 4). The common step is later → renders above
    // the unit block; the unit block splits into backend/frontend sub-headers.
    renderSection({
      documents: [
        doc({
          id: 'be',
          title: 'Doc BE',
          createdByStageInstanceId: 'si-be',
          createdAt: '2026-01-01T10:00:00Z',
        }),
        doc({
          id: 'fe',
          title: 'Doc FE',
          createdByStageInstanceId: 'si-fe',
          createdAt: '2026-01-01T11:00:00Z',
        }),
        doc({
          id: 'bt',
          title: 'Doc BT',
          createdByStageInstanceId: 'si-bt',
          createdAt: '2026-01-02T09:00:00Z',
        }),
      ],
      stageRows: [
        row({
          stageId: 'code-gen',
          stageInstanceId: 'si-be',
          phase: '02',
          order: 3,
          unitSlug: 'backend',
        }),
        row({
          stageId: 'code-gen',
          stageInstanceId: 'si-fe',
          phase: '02',
          order: 3,
          unitSlug: 'frontend',
        }),
        row({
          stageId: 'build-and-test',
          stageInstanceId: 'si-bt',
          phase: '02',
          order: 4,
          unitSlug: null,
        }),
      ],
    });

    // Unit sub-headers appear (humanized slug).
    expect(screen.getByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('Frontend')).toBeInTheDocument();

    // The common build-and-test doc (latest stage) sits ABOVE the unit block.
    // Within the unit block, same stage/order → date desc, so Frontend (11:00)
    // precedes Backend (10:00).
    expect(orderedLabels(['Doc BT', 'Frontend', 'Doc FE', 'Backend', 'Doc BE'])).toEqual([
      'Doc BT', //   common run first (stage order 4, most recent)
      'Frontend', // unit sub-header (newer doc)
      'Doc FE',
      'Backend', //  unit sub-header (older doc)
      'Doc BE',
    ]);
  });

  it('stays flat (no unit sub-headers) when a phase has a single unit', () => {
    renderSection({
      documents: [
        doc({ id: 'a', title: 'Doc A', createdByStageInstanceId: 'si-a' }),
        doc({ id: 'b', title: 'Doc B', createdByStageInstanceId: 'si-b' }),
      ],
      stageRows: [
        row({ stageId: 's1', stageInstanceId: 'si-a', phase: '01', order: 1, unitSlug: 'backend' }),
        row({ stageId: 's2', stageInstanceId: 'si-b', phase: '01', order: 2, unitSlug: null }),
      ],
    });
    // Only one unit lane present → no sub-header rendered.
    expect(screen.queryByText('Backend')).not.toBeInTheDocument();
    expect(screen.getByText('Doc A')).toBeInTheDocument();
    expect(screen.getByText('Doc B')).toBeInTheDocument();
  });

  it('renders ONE header per unit even when the unit spans multiple stages', () => {
    // Regression: a unit (Infrastructure) with docs from TWO stages (Functional
    // Design + Code Generation) must appear under a single header, contiguous —
    // not split once per stage.
    renderSection({
      documents: [
        doc({
          id: 'infra-fd',
          title: 'Doc Infra FD',
          createdByStageInstanceId: 'si-infra-fd',
          createdAt: '2026-01-01T09:00:00Z',
        }),
        doc({
          id: 'infra-cg',
          title: 'Doc Infra CG',
          createdByStageInstanceId: 'si-infra-cg',
          createdAt: '2026-01-01T12:00:00Z',
        }),
        doc({
          id: 'fe-cg',
          title: 'Doc FE CG',
          createdByStageInstanceId: 'si-fe-cg',
          createdAt: '2026-01-01T11:00:00Z',
        }),
      ],
      stageRows: [
        row({
          stageId: 'functional-design',
          stageInstanceId: 'si-infra-fd',
          phase: '02',
          order: 2,
          unitSlug: 'infrastructure',
        }),
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-infra-cg',
          phase: '02',
          order: 3,
          unitSlug: 'infrastructure',
        }),
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-fe-cg',
          phase: '02',
          order: 3,
          unitSlug: 'frontend',
        }),
      ],
    });
    // Exactly one "Infrastructure" header despite two producing stages.
    expect(screen.getAllByText('Infrastructure')).toHaveLength(1);
    expect(screen.getByText('Frontend')).toBeInTheDocument();
    // Infrastructure's two docs are contiguous under its single header.
    expect(orderedLabels(['Infrastructure', 'Doc Infra CG', 'Doc Infra FD'])).toEqual([
      'Infrastructure',
      'Doc Infra CG', // stage order 3, newer
      'Doc Infra FD', // stage order 2, older
    ]);
  });
});
