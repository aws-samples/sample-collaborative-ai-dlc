// Readable persona rendering for the ensemble timeline.
//
// S0 gave `v2.persona.*` its dot colour from the event-type SUFFIX. That is half
// the job: `v2.persona.contribution` as a headline says nothing about WHO acted or
// in what role, and being able to follow who did what is the entire reason real
// per-persona sessions get first-class timeline events. These tests pin the other
// half — a readable label plus the persona name, with the event's own summary kept
// as a bounded excerpt underneath.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const LONG_POSITION = `OBJECT: ${'the retry budget is wrong '.repeat(20)}`;

const EVENTS = [
  {
    eventId: 'p1',
    type: 'v2.persona.contribution',
    actor: 'aidlc-design-agent',
    summary: 'aidlc-design-agent contributed to user-stories (round 1): AGREE: the split holds',
  },
  {
    eventId: 'p2',
    type: 'v2.persona.link_completed',
    actor: 'aidlc-architect-agent',
    summary: 'Pipeline link 2/2 completed by aidlc-architect-agent on reverse-engineering',
  },
  {
    eventId: 'p3',
    type: 'v2.persona.dissent',
    actor: 'aidlc-quality-agent',
    summary: 'Maintained dissent on user-stories (aidlc-quality-agent, knowledge): missing NFRs',
    detail: { round: 1 },
  },
  // Round 2 of 2: the cap is spent, which is a materially different situation
  // from a first objection and must read differently in the feed.
  {
    eventId: 'p8',
    type: 'v2.persona.dissent',
    actor: 'aidlc-architect-agent',
    summary: 'Maintained dissent on user-stories (aidlc-architect-agent, knowledge): still no NFRs',
    detail: { round: 2, maxRounds: 2 },
  },
  // No round stamped (an older event): the label must not invent one.
  {
    eventId: 'p9',
    type: 'v2.persona.dissent',
    actor: 'aidlc-security-agent',
    summary: 'Maintained dissent on user-stories (aidlc-security-agent, knowledge): authz gap',
  },
  // The gate-plane summary event: the only record the plane ran when everything
  // passed, so it needs its own headline (the engine emits it; this pins the rendering).
  {
    eventId: 'p10',
    type: 'v2.sensor.gate',
    actor: 'agentcore',
    summary: 'Gate sensors: 4 passed, 0 flagged',
  },
  {
    eventId: 'p4',
    type: 'v2.persona.gap',
    actor: 'aidlc-developer-agent',
    summary:
      'GAP — support persona aidlc-developer-agent produced no evidence for user-stories: no contribution artifact after one reduced-brief retry',
  },
  // Orchestration-level gap: no persona owns it, so the label must not invent one.
  {
    eventId: 'p5',
    type: 'v2.persona.gap',
    actor: 'agentcore',
    summary: 'Ensemble sessions skipped for user-stories: the lead session parked on a question',
  },
  {
    eventId: 'p6',
    type: 'v2.persona.contribution',
    actor: 'aidlc-verbose-agent',
    summary: LONG_POSITION,
  },
  // A non-persona event must keep rendering its summary as the headline.
  { eventId: 'p7', type: 'v2.stage.succeeded', actor: 'agentcore', summary: 'Stage X succeeded' },
].map((event, index) => ({
  ...event,
  timestamp: `2026-09-24T10:${String(index).padStart(2, '0')}:00Z`,
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

describe('IntentActivityPanel ensemble persona rendering', () => {
  it('headlines each persona event with its role and the persona that acted', () => {
    render(<IntentActivityPanel onClose={() => {}} />);

    expect(screen.getByText('Contribution — aidlc-design-agent')).toBeTruthy();
    expect(screen.getByText('Pipeline link — aidlc-architect-agent')).toBeTruthy();
    expect(screen.getByText('Maintained dissent (round 1/2) — aidlc-quality-agent')).toBeTruthy();
    expect(screen.getByText('No evidence recorded — aidlc-developer-agent')).toBeTruthy();
  });

  it('names no persona when the engine, not a persona, produced the event', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('No evidence recorded')).toBeTruthy();
  });

  it('keeps the event summary as a short excerpt under the headline', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(
      screen.getByText(
        'aidlc-design-agent contributed to user-stories (round 1): AGREE: the split holds',
      ),
    ).toBeTruthy();
  });

  it('truncates a long excerpt so one verbose persona cannot flood the feed', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    const headline = screen.getByText('Contribution — aidlc-verbose-agent');
    const excerpt = headline.parentElement?.querySelector('p.line-clamp-3');
    expect(excerpt?.textContent?.endsWith('\u2026')).toBe(true);
    expect((excerpt?.textContent ?? '').length).toBeLessThanOrEqual(241);
    expect((excerpt?.textContent ?? '').length).toBeGreaterThan(100);
  });

  it('leaves a non-persona event headlined by its own summary', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Stage X succeeded')).toBeTruthy();
  });
});

describe('IntentActivityPanel dissent rounds and the gate-sensor summary', () => {
  it('names the dissent round out of the cap so a final objection reads as final', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Maintained dissent (round 1/2) — aidlc-quality-agent')).toBeTruthy();
    expect(screen.getByText('Maintained dissent (round 2/2) — aidlc-architect-agent')).toBeTruthy();
  });

  it('omits the round when the event never stamped one', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByText('Maintained dissent — aidlc-security-agent')).toBeTruthy();
  });

  it('headlines the gate-plane sensor summary and keeps its counts as the excerpt', () => {
    render(<IntentActivityPanel onClose={() => {}} />);
    const headline = screen.getByText('Gate sensors');
    expect(headline.parentElement?.querySelector('p.line-clamp-3')?.textContent).toBe(
      'Gate sensors: 4 passed, 0 flagged',
    );
  });
});
