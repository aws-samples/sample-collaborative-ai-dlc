// Timeline colours for release-semantics event families.
//
// The families are classified by SUFFIX rather than enumerated, so the streams
// that come after this one only have to EMIT `v2.<family>.<outcome>` — no
// frontend change per event type. These tests pin that contract, including the
// one deliberate exception: a failed gate RESUME is a wait the human clears, not
// a failure of the work, because the answer itself is safely recorded.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const EVENTS = [
  { eventId: 'e1', type: 'v2.gate.resume_failed', summary: 'Gate answer recorded, resume failed' },
  { eventId: 'e2', type: 'v2.gate.resumed', summary: 'Run resumed' },
  { eventId: 'e3', type: 'v2.gate.override', summary: 'Overrode 1 blocking finding' },
  { eventId: 'e4', type: 'v2.review.advisory', summary: 'Advisory review recorded' },
  { eventId: 'e5', type: 'v2.summary.confirmed', summary: 'Consolidated summary confirmed' },
  { eventId: 'e6', type: 'v2.summary.changes_requested', summary: 'Summary changes requested' },
  {
    eventId: 'e7',
    type: 'v2.summary.noncompliant',
    summary: 'Outputs written without confirmation',
  },
  { eventId: 'e8', type: 'v2.persona.contribution', summary: 'design-agent contributed' },
  { eventId: 'e9', type: 'v2.persona.gap', summary: 'design-agent produced nothing' },
  { eventId: 'e10', type: 'v2.sensor.gate', summary: 'Gate-plane sensor verdict' },
  { eventId: 'e11', type: 'v2.change.accepted', summary: 'Changed input accepted' },
  { eventId: 'e12', type: 'v2.change.reconfirmed', summary: 'Changed input reconfirmed' },
  { eventId: 'e13', type: 'v2.loopback.recommended', summary: 'Loop back to code-generation' },
  { eventId: 'e14', type: 'v2.loopback.recorded', summary: 'Looped back to code-generation' },
  // A family member nobody has classified yet: the suffix rule still colours it.
  { eventId: 'e15', type: 'v2.persona.link_completed', summary: 'Pipeline link 2 completed' },
  { eventId: 'e16', type: 'v2.change.halt', summary: 'Change control halted the stage' },
  { eventId: 'e17', type: 'v2.plan.approved', summary: 'Code generation plan approved' },
  { eventId: 'e18', type: 'v2.plan.changes_requested', summary: 'Plan changes requested' },
  { eventId: 'e19', type: 'v2.learning.recorded', summary: 'Learning recorded' },
  { eventId: 'e20', type: 'v2.learning.record_failed', summary: 'Learning write failed' },
  { eventId: 'e21', type: 'v2.units.fanout_approved', summary: 'Unit fan-out approved' },
  { eventId: 'e23', type: 'v2.sensor.gate', summary: 'Gate sensors: 2 passed, 0 flagged' },
  {
    eventId: 'e24',
    type: 'v2.review.advisory',
    actor: 'arch-reviewer',
    summary: '## Review\n\n**Verdict:** READY\n\n| ID | Finding |\n|---|---|\n| Finding 1 | ok |',
  },
  {
    eventId: 'e22',
    type: 'v2.persona.question_withdrawn',
    actor: 'design-agent',
    summary: 'Withdrew an orphaned persona question',
  },
].map((event, index) => ({
  ...event,
  timestamp: `2026-08-11T10:${String(index).padStart(2, '0')}:00Z`,
}));

vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: { intent: { id: 'i1' }, events: EVENTS },
    stageRows: [],
    agentFocus: null,
    previewSeq: 0,
    outputBuffers: new Map(),
    outputVersion: 1,
    stageNameOf: (key: string) => key,
    ensureOutputs: vi.fn(),
    outputPaneStatus: () => 'seeded',
  }),
}));
vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => <div />,
  useDiscussions: () => ({ discussions: [], isOpen: false, activeDiscussion: null }),
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({
  DiscussionsTab: () => <div />,
}));

import { IntentActivityPanel } from './IntentActivityPanel';

const dotClassFor = (summary: string) => {
  const item = screen.getByText(summary).closest('.flex.gap-3.py-2');
  for (const candidate of ['bg-agent-success', 'bg-agent-waiting', 'bg-agent-error']) {
    if (item?.querySelector(`.${candidate}`)) return candidate;
  }
  return item?.querySelector('.bg-muted-foreground') ? 'bg-muted-foreground' : null;
};

describe('IntentActivityPanel release-semantics event colours', () => {
  it('colours every new family by outcome without an entry per event type', () => {
    render(<IntentActivityPanel onClose={() => {}} />);

    for (const summary of [
      'Run resumed',
      'Consolidated summary confirmed',
      'design-agent contributed',
      'Changed input accepted',
      'Changed input reconfirmed',
      'Looped back to code-generation',
      'Pipeline link 2 completed',
      'Code generation plan approved',
      'Learning recorded',
      'Unit fan-out approved',
    ]) {
      expect(dotClassFor(summary)).toBe('bg-agent-success');
    }

    expect(dotClassFor('Overrode 1 blocking finding')).toBe('bg-agent-waiting');

    for (const summary of [
      'Advisory review recorded',
      'Summary changes requested',
      'Outputs written without confirmation',
      'design-agent produced nothing',
      'Gate-plane sensor verdict',
      'Loop back to code-generation',
      'Plan changes requested',
    ]) {
      expect(dotClassFor(summary)).toBe('bg-agent-waiting');
    }

    expect(dotClassFor('Change control halted the stage')).toBe('bg-agent-error');
    expect(dotClassFor('Learning write failed')).toBe('bg-agent-error');
  });

  it('names a withdrawn persona question instead of the generic persona label', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Question withdrawn — design-agent')).toBeInTheDocument();
  });

  it('treats a failed gate resume as a wait to clear, not a failed run', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(dotClassFor('Gate answer recorded, resume failed')).toBe('bg-agent-waiting');
  });

  it('reads a gate pass with nothing flagged as a clean pass', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(dotClassFor('Gate sensors: 2 passed, 0 flagged')).toBe('bg-agent-success');
  });

  it('headlines an advisory review and strips Markdown markup from its excerpt', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getAllByText('Advisory review').length).toBeGreaterThan(0);
    const excerpt = screen.getByText(/Verdict: READY/);
    expect(excerpt.textContent).not.toMatch(/##|\*\*|\|---/);
  });
});
