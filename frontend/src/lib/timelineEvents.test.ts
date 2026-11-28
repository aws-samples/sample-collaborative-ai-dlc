// One readable line per activity event, grouped by stage, with repeated
// low-value events folded together. These tests pin the contract the Timeline
// tab renders: plain labels (no UUID/SHA/slug as the headline), approvals,
// failures and deliveries never grouped away, raw payload kept one action away.

import { describe, expect, it } from 'vitest';
import type { IntentActivityEvent } from '@/services/intents';
import {
  buildTimeline,
  describeTimelineEvent,
  filterTimeline,
  type TimelineContext,
} from './timelineEvents';

let seq = 0;
const ev = (
  type: string,
  summary: string | null,
  extra: Partial<IntentActivityEvent> = {},
): IntentActivityEvent => {
  seq += 1;
  return {
    eventId: `e${seq}`,
    type,
    stageInstanceId: null,
    actor: 'agentcore',
    summary,
    timestamp: `2026-07-18T10:${String(seq).padStart(2, '0')}:00Z`,
    ...extra,
  };
};

const ctx: TimelineContext = {
  stageNameOf: (key) =>
    ({ 'si-req': 'requirements-analysis', 'si-cap': 'intent-capture', 'si-cg': 'code-generation' })[
      key
    ] ?? key,
  stages: [
    { stageInstanceId: 'si-req', stageId: 'requirements-analysis', unitSlug: null },
    { stageInstanceId: 'si-cap', stageId: 'intent-capture', unitSlug: null },
    { stageInstanceId: 'si-cg', stageId: 'code-generation', unitSlug: 'cart-badge-template' },
  ],
};

describe('describeTimelineEvent', () => {
  it('turns stage lifecycle events into plain sentences with the stage name', () => {
    const si = { stageInstanceId: 'si-req' };
    expect(
      describeTimelineEvent(ev('v2.stage.running', 'Stage requirements-analysis running', si), ctx)
        .label,
    ).toBe('Stage Requirements Analysis started');
    expect(
      describeTimelineEvent(
        ev('v2.stage.succeeded', 'Stage requirements-analysis succeeded', si),
        ctx,
      ).label,
    ).toBe('Stage Requirements Analysis completed');
    expect(
      describeTimelineEvent(
        ev(
          'v2.stage.parked',
          'Stage requirements-analysis parked on question q-6b3fdecf-3b0c-4a71-a19e-39256ac2109e',
          si,
        ),
        ctx,
      ).label,
    ).toBe('Stage Requirements Analysis is waiting for your answer');
    // Approval events carry no stage instance; the stage comes from the summary.
    const approved = describeTimelineEvent(
      ev('v2.stage.validated', 'Stage intent-capture approved by human validation'),
      ctx,
    );
    expect(approved.label).toBe('Stage Intent Capture approved');
    expect(approved.tone).toBe('success');
    expect(approved.groupKey).toBeNull();
  });

  it('names questions and answers', () => {
    expect(
      describeTimelineEvent(ev('v2.question.asked', 'Agent asked 1 question(s)'), ctx).label,
    ).toBe('Agent asked 1 question');
    const asked = describeTimelineEvent(ev('v2.question.asked', 'Agent asked 3 question(s)'), ctx);
    expect(asked.label).toBe('Agent asked 3 questions');
    expect(asked.category).toBe('question');
    expect(asked.tone).toBe('waiting');
    const answered = describeTimelineEvent(
      ev('v2.question.answered', 'hectorsy@amazon.fr answered "Where…" with "2; 3"', {
        actor: 'hectorsy@amazon.fr',
        answeredByName: 'Hector',
        questions: JSON.stringify([{ text: 'Where should it live?' }]),
        answer: { answers: [{ selectedOptions: [0], freeText: '' }] },
      }),
      ctx,
    );
    expect(answered.label).toBe('Hector answered');
    expect(answered.category).toBe('question');
  });

  it('keeps SHAs, branch names and ids out of the headline', () => {
    const pushed = describeTimelineEvent(
      ev(
        'v2.git.pushed',
        'Engine committed + pushed work for workspace-detection (eipasteur/retail-store-ui@f3bcb0a2)',
      ),
      ctx,
    );
    expect(pushed.label).toBe('Work pushed to retail-store-ui');
    expect(pushed.label).not.toMatch(/f3bcb0a2/);
    expect(pushed.category).toBe('delivery');

    const merged = describeTimelineEvent(
      ev(
        'v2.git.merged',
        'Engine merged aidlc/x--s1-unit-cart-badge-template into aidlc/x (eipasteur/retail-store-ui@eb35ee69, eipasteur/retail-store-cart@a848bc2d)',
        { unitSlug: 'cart-badge-template' },
      ),
      ctx,
    );
    expect(merged.label).toBe(
      'Unit Cart Badge Template merged into the intent branch (2 repositories)',
    );

    const pr = describeTimelineEvent(
      ev('v2.pr.opened', 'Opened PR #57 on eipasteur/retail-store-ui'),
      ctx,
    );
    expect(pr.label).toBe('PR #57 opened');
    expect(pr.category).toBe('delivery');
  });

  it('describes failures in plain words and classifies them as errors', () => {
    const pushFailed = describeTimelineEvent(
      ev(
        'v2.git.push_failed',
        "Engine push failed for reverse-engineering: eipasteur/retail-store-ui (push_failed: dlc/x (fetch first)\nerror: failed to push some refs to 'https://github.com/eipasteur/retail-store-ui.git'",
      ),
      ctx,
    );
    expect(pushFailed.label).toBe('Push to retail-store-ui failed');
    expect(pushFailed.category).toBe('error');
    expect(pushFailed.tone).toBe('error');
    expect(pushFailed.excerpt).toBe('The work could not be pushed to the repository.');

    const stageFailed = describeTimelineEvent(
      ev(
        'v2.stage.failed',
        'push_failed: eipasteur/retail-store-ui: push_failed — dlc/x (fetch first)',
        {
          stageInstanceId: 'si-req',
        },
      ),
      ctx,
    );
    expect(stageFailed.label).toBe('Stage Requirements Analysis failed');
    expect(stageFailed.excerpt).toBeTruthy();
    expect(stageFailed.excerpt).not.toMatch(/dlc\/x/);

    const runFailed = describeTimelineEvent(
      ev('v2.execution.failed', 'stage_failed: reverse-engineering: push_failed'),
      ctx,
    );
    expect(runFailed.label).toBe('Run failed in Reverse Engineering');
    expect(runFailed.groupKey).toBeNull();
  });

  it('turns documents and projections into plain lines', () => {
    const created = describeTimelineEvent(
      ev('v2.artifact.created', 'Artifact created: Intent Statement — Cart Item Count Badge'),
      ctx,
    );
    expect(created.label).toBe('Document created: Intent Statement — Cart Item Count Badge');
    expect(created.category).toBe('document');
    expect(created.groupKey).toBe('documents-created');

    const derived = describeTimelineEvent(
      ev(
        'v2.derive.completed',
        'Derived graph projection: 3 artifact(s), 17 section(s), 0 item(s), 0 item edge(s), 0 citation set(s), 3 enriched',
      ),
      ctx,
    );
    expect(derived.label).toBe('Knowledge graph updated');
    expect(derived.excerpt).toBeNull();
  });

  it('reads advisory sensor flags and reviewer rounds without the raw report', () => {
    const flagged = describeTimelineEvent(
      ev('v2.sensor.flagged', 'Sensor required-sections (advisory) → FAIL'),
      ctx,
    );
    expect(flagged.label).toBe('Advisory check flagged: Required Sections');
    expect(flagged.groupKey).toBe('advisory-sensor');
    expect(flagged.category).not.toBe('error');

    const blocking = describeTimelineEvent(
      ev('v2.sensor.flagged', 'Sensor required-artifacts (blocking) → FAIL'),
      ctx,
    );
    expect(blocking.label).toBe('Blocking check flagged: Required Artifacts');
    expect(blocking.groupKey).toBeNull();

    const ready = describeTimelineEvent(
      ev(
        'v2.review.ready',
        'Reviewer aidlc-product-lead-agent returned READY: **Reviewer:** x\n\n## Review',
        {
          actor: 'aidlc-product-lead-agent',
        },
      ),
      ctx,
    );
    expect(ready.label).toBe('Product Lead Agent review: ready');
    expect(ready.excerpt).toBeNull();
    const notReady = describeTimelineEvent(
      ev('v2.review.not_ready', 'Reviewer aidlc-product-lead-agent returned NOT-READY: …', {
        actor: 'aidlc-product-lead-agent',
      }),
      ctx,
    );
    expect(notReady.label).toBe('Product Lead Agent review: changes needed');
    expect(notReady.tone).toBe('waiting');
  });

  it('shows agent notes as an excerpt under a short headline', () => {
    const note = describeTimelineEvent(
      ev('discovery', 'Explored workspace structure. Project is a multi-service retail store.', {
        actor: 'si-649d151f25dad31b',
      }),
      ctx,
    );
    expect(note.label).toBe('Agent discovery');
    expect(note.excerpt).toBe(
      'Explored workspace structure. Project is a multi-service retail store.',
    );
    expect(note.category).toBe('note');
  });

  it('falls back to the summary when it is clean, else to a humanised type', () => {
    const clean = describeTimelineEvent(
      ev('v2.summary.confirmed', 'Consolidated summary confirmed'),
      ctx,
    );
    expect(clean.label).toBe('Consolidated summary confirmed');
    expect(clean.tone).toBe('success');

    const noisy = describeTimelineEvent(
      ev(
        'v2.unit.lane_ready',
        'Lane workspace ready for unit cart-badge-template on aidlc/show-cart--s1-unit-cart-badge-template (section 1, 6 repo(s))',
        { unitSlug: 'cart-badge-template' },
      ),
      ctx,
    );
    expect(noisy.label).toBe('Workspace ready for unit Cart Badge Template');

    const empty = describeTimelineEvent(ev('v2.stage.note', ''), ctx);
    expect(empty.label).toBe('Stage note');

    const unknown = describeTimelineEvent(
      ev('v2.quorum_edit.plan_ready', 'Plan ready for aidlc/x@deadbeef12345678'),
      ctx,
    );
    expect(unknown.label).toBe('Quorum edit: plan ready');
  });

  it('reads unit orchestration events as sentences with real plurals', () => {
    expect(
      describeTimelineEvent(
        ev(
          'v2.units.section_started',
          'Section 1 fanning out: skeleton cart-badge-template, 2 unit(s) across 2 wave(s)',
        ),
        ctx,
      ),
    ).toMatchObject({ label: 'Section 1 started', excerpt: '2 units in 2 waves' });
    expect(
      describeTimelineEvent(ev('v2.units.fan_in', 'Section 1 complete: 2/2 unit(s) merged'), ctx),
    ).toMatchObject({ label: 'Section 1 complete', excerpt: '2 of 2 units merged' });
    expect(
      describeTimelineEvent(
        ev('v2.units.autonomy_set', 'Construction autonomy for section 1: autonomous'),
        ctx,
      ).label,
    ).toBe('Construction autonomy set to autonomous');
    expect(
      describeTimelineEvent(
        ev('v2.units.batch_approved', 'Batch approved: 3 unit(s), 1 wave(s)'),
        ctx,
      ).label,
    ).toBe('Batch approved: 3 units, 1 wave');
    expect(
      describeTimelineEvent(
        ev(
          'v2.plan.warnings',
          'Plan resolved with 2 scope warning(s): scope_absent_consume, scope_absent_unit_dag',
        ),
        ctx,
      ),
    ).toMatchObject({
      label: 'Plan resolved with 2 scope warnings',
      excerpt:
        'A stage needs an input that nothing in this scope produces; it runs without it. Stages meant to run once per unit run once, because nothing in this scope splits the work into units.',
    });
    // Unknown codes are not humanised into nonsense: count only, codes in Details.
    const unknown = describeTimelineEvent(
      ev('v2.plan.warnings', 'Plan resolved with 1 scope warning(s): brand_new_code'),
      ctx,
    );
    expect(unknown).toMatchObject({ label: 'Plan resolved with 1 scope warning', excerpt: null });
    expect(unknown.technical.find((t) => t.label === 'Summary')?.value).toMatch(/brand_new_code/);
  });

  it('names people instead of e-mail addresses, and "you" for the signed-in user', () => {
    const people: TimelineContext = {
      ...ctx,
      currentUser: { userId: 'sub-hector', email: 'hectorsy@amazon.fr' },
      members: [
        { userId: 'sub-hector', email: 'hectorsy@amazon.fr' },
        { userId: 'sub-jan', email: 'jan.thewes@example.com' },
      ],
    };
    const cancelledByMe = describeTimelineEvent(
      ev('v2.execution.cancelled', 'Run cancelled', { actor: 'hectorsy@amazon.fr' }),
      people,
    );
    expect(cancelledByMe.label).toBe('Run cancelled by you');
    // The e-mail stays one action away.
    expect(cancelledByMe.technical.find((t) => t.label === 'Actor')?.value).toBe(
      'hectorsy@amazon.fr',
    );
    expect(
      describeTimelineEvent(
        ev('v2.execution.cancelled', 'Run cancelled', { actor: 'sub-jan' }),
        people,
      ).label,
    ).toBe('Run cancelled by Jan Thewes');
    expect(
      describeTimelineEvent(
        ev('v2.question.answered', 'x answered', { actor: 'hectorsy@amazon.fr' }),
        people,
      ).label,
    ).toBe('You answered');
    // Without member data an address still reads as a name.
    expect(
      describeTimelineEvent(
        ev('v2.execution.cancelled', 'Run cancelled', { actor: 'jan.thewes@example.com' }),
        ctx,
      ).label,
    ).toBe('Run cancelled by Jan Thewes');
  });

  it('rewrites recompose, edit and compose summaries without e-mails, slugs or quotes', () => {
    const people: TimelineContext = {
      ...ctx,
      currentUser: { userId: 'sub-hector', email: 'hectorsy@amazon.fr' },
    };
    const recomposed = describeTimelineEvent(
      ev(
        'v2.execution.recomposed',
        'hectorsy@amazon.fr recomposed the run (21 of 32 stages, scope label "mvp-recomposed") — relaunching at feasibility',
        { actor: 'hectorsy@amazon.fr' },
      ),
      people,
    );
    expect(recomposed.label).toBe('You reshaped the run from Feasibility');
    expect(recomposed.excerpt).toBe('21 of 32 stages · MVP Recomposed scope');

    const edited = describeTimelineEvent(
      ev(
        'v2.artifact.edited',
        'jan.thewes@example.com edited "Requirements" — 2 downstream artifact(s) marked possibly stale',
        { actor: 'jan.thewes@example.com' },
      ),
      people,
    );
    expect(edited.label).toBe('Jan Thewes edited Requirements');
    expect(edited.excerpt).toBe('2 downstream documents may be out of date');

    expect(
      describeTimelineEvent(ev('v2.compose.completed', 'Composer proposed scope "mvp"'), ctx).label,
    ).toBe('Composer proposed the MVP scope');
    expect(
      describeTimelineEvent(
        ev('v2.compose.completed', 'Composer proposed a custom grid ("custom-x")'),
        ctx,
      ).label,
    ).toBe('Composer proposed a custom plan');
  });

  it('names the failed stage from the failure text, else says "A stage failed"', () => {
    const named = describeTimelineEvent(
      ev('v2.stage.failed', 'stage_failed: reverse-engineering: unsupported_for_each', {
        stageInstanceId: 'si-unknown',
      }),
      ctx,
    );
    expect(named.label).toBe('Stage Reverse Engineering failed');
    const anonymous = describeTimelineEvent(
      ev('v2.stage.failed', 'boom', { stageInstanceId: 'si-unknown' }),
      ctx,
    );
    expect(anonymous.label).toBe('A stage failed');
    expect(anonymous.label).not.toMatch(/Stage Stage/);
  });

  it('shows the recorded time as a date, with the ISO value copyable', () => {
    const d = describeTimelineEvent(ev('v2.execution.succeeded', 'done'), ctx);
    expect(d.technical.find((t) => t.label === 'Recorded at')?.value).not.toMatch(/T\d\d:/);
    expect(d.technical.find((t) => t.label === 'Timestamp')).toMatchObject({ copy: true });
  });

  it('exposes the raw payload as technical details', () => {
    const d = describeTimelineEvent(
      ev(
        'v2.git.pushed',
        'Engine committed + pushed work for x (eipasteur/retail-store-ui@f3bcb0a2)',
        {
          stageInstanceId: 'si-req',
        },
      ),
      ctx,
    );
    const labels = d.technical.map((t) => t.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Event type', 'Event id', 'Summary', 'Stage instance']),
    );
    expect(d.technical.find((t) => t.label === 'Summary')?.value).toMatch(/f3bcb0a2/);
  });
});

describe('buildTimeline', () => {
  it('groups events by stage (newest group first) and folds repeated low-value events', () => {
    const events = [
      ev('v2.workspace.initializing', 'Initializing workspace (6 repo(s))…', {
        actor: 'orchestrator',
      }),
      ev('v2.workspace.initialized', 'Workspace ready', { actor: 'orchestrator' }),
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.question.asked', 'Agent asked 3 question(s)', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.parked', 'Stage intent-capture parked on question q-1', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.question.answered', 'hectorsy@amazon.fr answered "x" with "y"', {
        stageInstanceId: 'si-cap',
        actor: 'hectorsy@amazon.fr',
      }),
      ev('v2.workspace.restoring', 'Restoring workspace...', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.resuming', 'Resuming agent session...', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.resumed', 'Stage intent-capture resumed', { stageInstanceId: 'si-cap' }),
      ev('v2.artifact.created', 'Artifact created: Intent Capture Questions', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.artifact.created', 'Artifact created: Intent Statement', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.artifact.created', 'Artifact created: Stakeholder Map', { stageInstanceId: 'si-cap' }),
      ev('v2.derive.completed', 'Derived graph projection: 3 artifact(s)', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.stage.succeeded', 'Stage intent-capture succeeded', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.validated', 'Stage intent-capture approved by human validation', {
        actor: 'orchestrator',
      }),
      ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
    ];
    const groups = buildTimeline(events, ctx);

    expect(groups.map((g) => g.title)).toEqual(['Requirements Analysis', 'Intent Capture', 'Run']);
    expect(groups[0].stageInstanceId).toBe('si-req');

    const capture = groups[1];
    const labels = capture.entries.map((e) => e.label);
    // Newest first inside the group; the approval (no stage instance of its own)
    // lands in the stage it names.
    expect(labels[0]).toBe('Stage Intent Capture approved');
    expect(labels).toContain('3 documents created');
    expect(labels).toContain('Stage Intent Capture resumed');
    expect(labels).not.toContain('Restoring workspace');
    expect(labels).toContain('Agent asked 3 questions');
    expect(labels).toContain('Hectorsy answered');
    const docs = capture.entries.find((e) => e.label === '3 documents created')!;
    expect(docs.grouped).toBe(true);
    expect(docs.events).toHaveLength(3);
    expect(docs.excerpt).toBe('Intent Capture Questions, Intent Statement, Stakeholder Map');
    // `questions` counts entries (asked + answered + parked); `asked` counts
    // the questions themselves — the group pill reads the latter.
    expect(capture.counts).toEqual({ questions: 3, documents: 1, errors: 0 });

    const run = groups[2];
    expect(run.entries.map((e) => e.label)).toEqual(['Workspace ready']);
    expect(run.entries[0].events).toHaveLength(2);
  });

  it('never folds approvals, failures or deliveries, even when consecutive', () => {
    const events = [
      ev('v2.stage.validated', 'Stage intent-capture approved by human validation'),
      ev('v2.stage.validated', 'Stage market-research approved by human validation'),
      ev(
        'v2.git.push_failed',
        'Engine push failed for a: eipasteur/retail-store-ui (push_failed: x)',
      ),
      ev(
        'v2.git.push_failed',
        'Engine push failed for b: eipasteur/retail-store-ui (push_failed: x)',
      ),
      ev('v2.pr.opened', 'Opened PR #57 on eipasteur/retail-store-ui'),
      ev('v2.pr.opened', 'Opened PR #58 on eipasteur/retail-store-cart'),
    ];
    const [run] = buildTimeline(events, ctx);
    expect(run.entries).toHaveLength(6);
    expect(run.entries.every((e) => !e.grouped)).toBe(true);
    expect(run.counts.errors).toBe(2);
  });

  it('keeps a rewind together as one run-level entry instead of one group per reset stage', () => {
    const events = [
      ev('v2.stage.reset', 'Stage approval-handoff reset for rewind (attempt 2)', {
        stageInstanceId: 'si-a',
        actor: 'hectorsy@amazon.fr',
      }),
      ev('v2.stage.reset', 'Stage feasibility reset for rewind (attempt 2)', {
        stageInstanceId: 'si-b',
        actor: 'hectorsy@amazon.fr',
      }),
      ev(
        'v2.execution.rewound',
        'hectorsy@amazon.fr retried the run from workspace-scaffold (27 stage instance(s) reset, 33 artifact(s) superseded)',
        { actor: 'hectorsy@amazon.fr' },
      ),
    ];
    const groups = buildTimeline(events, ctx);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Run');
    expect(groups[0].entries.map((e) => e.label)).toEqual([
      'Run retried from Workspace Scaffold',
      '2 stages reset for retry',
    ]);
    expect(groups[0].entries[0].excerpt).toBe('27 stages reset, 33 documents superseded');
  });

  it('titles unit-lane stages with their unit and groups orchestrator unit events per unit', () => {
    const events = [
      ev('v2.unit.started', 'Unit cart-badge-template started on aidlc/x--s1 (section 1)', {
        actor: 'orchestrator',
        unitSlug: 'cart-badge-template',
      }),
      ev('v2.stage.running', 'Stage code-generation running', {
        stageInstanceId: 'si-cg',
        unitSlug: 'cart-badge-template',
      }),
    ];
    const groups = buildTimeline(events, ctx);
    expect(groups.map((g) => g.title)).toEqual(['Code Generation', 'Unit Cart Badge Template']);
    expect(groups[0].unitSlug).toBe('cart-badge-template');
    expect(groups[0].unitName).toBe('Cart Badge Template');
    expect(groups[1].unitSlug).toBeNull();
    expect(groups[1].entries[0].label).toBe('Unit Cart Badge Template started');
    // The slug stays one action away, in Details.
    expect(groups[1].entries[0].technical).toContainEqual({
      label: 'Unit',
      value: 'cart-badge-template',
    });
  });

  it('names units through the context when a readable title is known', () => {
    const named = { ...ctx, unitNameOf: (slug: string) => `Badge (${slug})` };
    const event = ev('v2.conflict.resolved', 'Conflicts resolved', {
      unitSlug: 'cart-badge-template',
    });
    expect(describeTimelineEvent(event, named).label).toBe(
      'Conflicts resolved for unit Badge (cart-badge-template)',
    );
    expect(describeTimelineEvent(event, ctx).label).toBe(
      'Conflicts resolved for unit Cart Badge Template',
    );
  });

  it('labels the attempt when the same stage instance returns after another stage ran', () => {
    const events = [
      ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
    ];
    expect(buildTimeline(events, ctx).map((g) => g.title)).toEqual([
      'Requirements Analysis · attempt 2',
      'Intent Capture',
      'Requirements Analysis',
    ]);
  });

  it('labels the attempt after a rewind reset the stage', () => {
    const events = [
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.stage.reset', 'Stage intent-capture reset for rewind (attempt 2)', {
        stageInstanceId: 'si-cap',
      }),
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
    ];
    const groups = buildTimeline(events, ctx);
    expect(groups.map((g) => g.title)).toEqual([
      'Intent Capture · attempt 2',
      'Run',
      'Intent Capture',
    ]);
    expect(groups[0].attempt).toBe(2);
  });

  it('merges a stage that only paused for run-level activity back into one group', () => {
    const events = [
      ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
      ev('v2.workspace.initialized', 'Workspace ready', { actor: 'orchestrator' }),
      ev('v2.question.asked', 'Agent asked 1 question(s)', { stageInstanceId: 'si-cap' }),
    ];
    const groups = buildTimeline(events, ctx);
    const capture = groups.filter((g) => g.title.startsWith('Intent Capture'));
    expect(capture).toHaveLength(1);
    expect(capture[0].title).toBe('Intent Capture');
    expect(capture[0].entries.map((e) => e.label)).toEqual([
      'Agent asked 1 question',
      'Stage Intent Capture started',
    ]);
    expect(capture[0].counts.questions).toBe(1);
  });

  it('puts events of a stage it cannot name in the run, not under a "Stage" group', () => {
    const groups = buildTimeline(
      [ev('v2.stage.failed', 'boom', { stageInstanceId: 'si-unknown' })],
      ctx,
    );
    expect(groups.map((g) => g.title)).toEqual(['Run']);
    expect(groups[0].entries[0].label).toBe('A stage failed');
  });

  it('names a failed stage without a row from the run failure that follows it', () => {
    const groups = buildTimeline(
      [
        ev('v2.stage.failed', 'not_implemented: mode pipeline', { stageInstanceId: 'si-re' }),
        ev(
          'v2.execution.failed',
          'stage_failed: reverse-engineering: not_implemented: mode pipeline',
        ),
      ],
      ctx,
    );
    expect(groups.map((g) => g.title)).toEqual(['Run', 'Reverse Engineering']);
    expect(groups[1].entries[0].label).toBe('Stage Reverse Engineering failed');
  });

  it('folds "skipped" repositories even when an opened pull request sits between them', () => {
    const [run] = buildTimeline(
      [
        ev(
          'v2.pr.skipped',
          'No PR for eipasteur/retail-store-ui: no changes between aidlc/x and main',
        ),
        ev('v2.pr.opened', 'PR opened for eipasteur/retail-store-cart: https://x/pull/57'),
        ev(
          'v2.pr.skipped',
          'No PR for eipasteur/retail-store-infra: no changes between aidlc/x and main',
        ),
      ],
      ctx,
    );
    expect(run.entries.map((e) => e.label)).toEqual([
      '2 repositories skipped — no changes',
      'Pull request opened',
    ]);
    expect(run.entries[0].excerpt).toBe('retail-store-ui, retail-store-infra');
  });

  it('folds identical "pull request skipped" events into one line with the repositories', () => {
    const skip = (repo: string) =>
      ev(
        'v2.pr.skipped',
        `No PR for eipasteur/${repo}: no changes between aidlc/x and main (no repo work was recorded this run)`,
      );
    const [run] = buildTimeline(
      [skip('retail-store-ui'), skip('retail-store-cart'), skip('retail-store-orders')],
      ctx,
    );
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0]).toMatchObject({
      label: '3 repositories skipped — no changes',
      excerpt: 'retail-store-ui, retail-store-cart, retail-store-orders',
      grouped: true,
    });
    expect(run.entries[0].technical.find((t) => t.label === 'Summaries')?.value).toMatch(
      /retail-store-orders/,
    );
  });
});

describe('filterTimeline', () => {
  const events = [
    ev('v2.stage.running', 'Stage intent-capture running', { stageInstanceId: 'si-cap' }),
    ev('v2.question.asked', 'Agent asked 1 question(s)', { stageInstanceId: 'si-cap' }),
    ev('v2.artifact.created', 'Artifact created: Intent Statement', { stageInstanceId: 'si-cap' }),
    ev('v2.stage.running', 'Stage requirements-analysis running', { stageInstanceId: 'si-req' }),
    ev('v2.stage.failed', 'push_failed: eipasteur/retail-store-ui: push_failed', {
      stageInstanceId: 'si-req',
    }),
  ];

  it('keeps only matching entries and drops empty groups', () => {
    const groups = buildTimeline(events, ctx);
    const questions = filterTimeline(groups, 'questions');
    expect(questions.map((g) => g.title)).toEqual(['Intent Capture']);
    expect(questions[0].entries.map((e) => e.label)).toEqual(['Agent asked 1 question']);

    const docs = filterTimeline(groups, 'documents');
    expect(docs[0].entries.map((e) => e.label)).toEqual(['Document created: Intent Statement']);

    const errors = filterTimeline(groups, 'errors');
    expect(errors.map((g) => g.title)).toEqual(['Requirements Analysis']);
    expect(errors[0].entries.map((e) => e.label)).toEqual(['Stage Requirements Analysis failed']);

    expect(filterTimeline(groups, 'all')).toBe(groups);
  });
});
