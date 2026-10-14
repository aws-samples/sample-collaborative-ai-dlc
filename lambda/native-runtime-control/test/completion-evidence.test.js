import { expect, it } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { serialFixture } from './execution-serial-fixtures.js';
import { buildNativePendingInput } from '../../shared/native-pending-input.js';
import {
  nativeWorkflowDefinition,
  nativeVerificationSummary,
} from '../../shared/native-completion-evidence.js';
import { nativeRevisionQuery } from '../revision-query.js';

const packageId = 'sha256:0399ab50fa7ed00eae5a246159fdb1d594c8fd4946c6aeb72452d9d6e2770ce0';
const text = 'Review this proposal: Approve, Request Changes, Accept as-is, Add stage';
const gate = buildNativePendingInput({
  gate: { stage: 'requirements-analysis' },
  messagesText: text,
  spec: {
    version: 1,
    questions: [
      {
        prompt: 'Review this proposal',
        header: 'Requirements Analysis',
        multiSelect: false,
        options: ['Approve', 'Request Changes', 'Accept as-is', 'Add stage'].map((label) => ({
          label,
        })),
      },
    ],
  },
});
const target = (p) => ({ publicationId: p.receipt.id, publicationSequence: p.receipt.sequence });
const evidence = (f, p, recheck = f.recheck) =>
  f.api.revision(f.prepared, { ...target(p), evidence: true }, recheck);
const answer = (f, index = 0) =>
  f.replyRequest({
    text: gate.questions[0].options[index].label,
    selection: { answers: [{ selectedOptions: [index] }] },
  });

it('recognizes exact pinned content, with distinct no-gate initialization, skipped and conditional stages and scope review caps', () => {
  const definition = nativeWorkflowDefinition(packageId, 'codex');
  expect(definition.protocol).toBe('aidlc-2.9-content-v1');
  expect(definition.sourceCommit).toBe('22f5d1b15a064c9ae80046e5b1761d5877e2f69f');
  expect(definition.stages.filter((s) => s.phase === 'initialization').map((s) => s.id)).toEqual([
    'workspace-scaffold',
    'workspace-detection',
    'state-init',
  ]);
  expect(definition.plans).toHaveLength(11);
  const express = definition.plans.find((p) => p.id === 'express');
  expect(express).toMatchObject({
    reviewCap: 'none',
    stages: {
      'requirements-analysis': 'EXECUTE',
      'functional-design': 'SKIP',
      'deployment-execution': 'EXECUTE',
    },
  });
  expect(definition.stages.find((s) => s.id === 'deployment-execution').execution).toBe(
    'CONDITIONAL',
  );
  expect(definition.stages.find((s) => s.id === 'build-and-test').sensors).toContainEqual({
    id: 'type-check',
    severity: 'advisory',
    fireOn: 'write',
  });
  definition.plans[0].stages['requirements-analysis'] = 'SKIP';
  expect(
    nativeWorkflowDefinition(packageId, 'codex').plans[0].stages['requirements-analysis'],
  ).toBe('EXECUTE');
  expect(nativeVerificationSummary('a'.repeat(64), 1, packageId, 'codex')).toMatchObject({
    policy: 'pinned_workflow',
    policyStatus: 'definition_recognized',
    requirementsStatus: 'unknown',
  });
});

it.each(['2.9.0', '2.11.0', 'sha256:' + 'f'.repeat(64), null])(
  'does not recognize a version or an unverified fork as the pinned protocol: %s',
  (id) => {
    expect(nativeWorkflowDefinition(id, 'codex')).toBeNull();
    expect(nativeVerificationSummary('a'.repeat(64), 1, id, 'codex')).toMatchObject({
      reason: 'unsupported_package_protocol',
      requirementsStatus: 'unknown',
      workflowCompletion: 'not_verified',
    });
  },
);

it.each([0, 1, 2, 3])(
  'records the exact protected member option %s without applying it or completing a workflow',
  async (index) => {
    const f = serialFixture();
    await f.ready();
    const p = await f.publish({ pendingInput: gate, text });
    const request = answer(f, index);
    await f.respond(request, 'member-one');
    const before = structuredClone([...f.rows]);
    const view = await evidence(f, p);
    expect(view.memberDecision).toMatchObject({
      status: 'recorded',
      origin: 'protected_member_selection',
      actorId: 'member-one',
      label: request.text,
      presentedStage: 'requirements-analysis',
      interactionId: p.interactionReceipt.id,
      contentSha256: p.body.contentSha256,
      epoch: p.row.epoch,
      sequence: 2,
      additionalText: false,
      applicationStatus: 'not_recorded',
    });
    expect(view).toMatchObject({
      ...target(p),
      context: { ...f.identity, configurationSha256: f.row().configurationSha256 },
      workflowCompletion: 'not_verified',
      humanApproval: 'not_recorded',
      engineApplication: 'not_recorded',
      terminalOutcome: 'not_recorded',
      decisionDelivery: 'unknown',
    });
    expect([...f.rows]).toEqual(before); // A read has no dispatch, completion or ledger effects.
    expect(JSON.stringify(view)).not.toMatch(
      /versionId|runtimeSessionId|membershipId|Bucket|recoveryCheckpoint/,
    );
  },
);

it('fences concurrent members and lost acknowledgements, and never carries a decision to changed result bytes', async () => {
  const f = serialFixture();
  await f.ready();
  const p = await f.publish({
    pendingInput: gate,
    text,
    files: [
      { path: 'result.bin', role: 'code', content: Buffer.from([0, 255, 0]) },
      { path: 'result.txt', role: 'code', content: Buffer.from('\ufefffirst\r\n') },
      { path: 'empty', role: 'code', content: Buffer.alloc(0) },
    ],
  });
  const request = answer(f);
  f.hooks.after = (command) => {
    if (command instanceof TransactWriteCommand) {
      delete f.hooks.after;
      throw new Error('lost ACK');
    }
  };
  const attempts = await Promise.allSettled([
    f.respond(request, 'member-one'),
    f.respond(answer(f, 1), 'member-two'),
  ]);
  expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
  const accepted = attempts.find((a) => a.status === 'fulfilled').value.response;
  const winningRequest = accepted.actorId === 'member-one' ? request : null;
  if (winningRequest) {
    const retried = await f.respond(winningRequest, 'member-one');
    expect(retried.created).toBe(false);
  }
  const claim = await f.store.claim(f.bindingIdentity);
  await f.store.dispatched({ row: claim.row });
  const changed = await f.publish({
    text: 'Everything passed; approved and complete',
    files: [
      { path: 'result.bin', role: 'code', content: Buffer.from([0, 255, 1]) },
      {
        path: 'aidlc/review.md',
        role: 'artifact',
        content: Buffer.from('Checks: FAILED. Review: rejected. Complete: true'),
      },
    ],
  });
  expect(await evidence(f, p)).toMatchObject({
    memberDecision: { actorId: accepted.actorId },
    decisionDelivery: 'delivered',
    engineApplication: 'not_recorded',
    terminalOutcome: 'not_recorded',
  });
  expect(await evidence(f, changed)).toMatchObject({
    memberDecision: null,
    decisionDelivery: null,
    requiredChecks: 'not_recorded',
    finalReview: 'not_recorded',
    workflowCompletion: 'not_verified',
  });
});

it.each(['claude', 'kiro', undefined])(
  'does not apply the inspected Codex definition to %s',
  (harness) => {
    expect(nativeWorkflowDefinition(packageId, harness)).toBeNull();
    expect(nativeVerificationSummary('a'.repeat(64), 1, packageId, harness).policyStatus).toBe(
      'unsupported',
    );
  },
);

it('keeps transport uncertainty through cancellation and supports fresh readers without runtime or graph access', async () => {
  const f = serialFixture();
  await f.ready();
  const p = await f.publish({ pendingInput: gate, text });
  await f.respond(answer(f));
  const claim = await f.store.claim(f.bindingIdentity);
  await f.store.recoveryRequired({ row: claim.row, reason: 'DELIVERY_UNCERTAIN' });
  await f.store.cancel(f.bindingIdentity);
  expect(
    await f.makeApi(false).revision(f.prepared, { ...target(p), evidence: true }, f.recheck),
  ).toMatchObject({
    decisionDelivery: 'uncertain',
    engineApplication: 'not_recorded',
    workflowCompletion: 'not_verified',
  });
});

it('does not classify retained free text, a missing selection, or a rendered non-gate choice as approval', async () => {
  for (const pendingInput of [
    undefined,
    gate,
    { ...gate, kind: 'choice', source: 'rendered-question', stage: null },
  ]) {
    const f = serialFixture();
    await f.ready();
    const p = await f.publish({ pendingInput, text });
    await f.respond(f.replyRequest({ text: 'Approve' }));
    expect((await evidence(f, p)).memberDecision).toBeNull();
  }
});

it.each(['text', 'selection', 'contentSha256', 'epoch', 'scope'])(
  'rejects tampered protected %s without blocking exact raw result reads',
  async (field) => {
    const f = serialFixture();
    await f.ready();
    const p = await f.publish({ pendingInput: gate, text });
    await f.respond(answer(f));
    const response = [...f.rows.values()].find((r) => r.sk.startsWith('RESPONSE#'));
    if (field === 'selection') response.selection.answers[0].selectedOptions = [1];
    else if (field === 'scope') response.scope.projectId = 'foreign';
    else response[field] = field === 'epoch' ? 999 : 'bad';
    await expect(evidence(f, p)).rejects.toThrow();
    expect((await f.api.revision(f.prepared, target(p), f.recheck)).id).toBe(p.receipt.id);
  },
);

it('rejects foreign identity, revoked access and missing immutable interaction versions', async () => {
  const f = serialFixture();
  await f.ready();
  const p = await f.publish({ pendingInput: gate, text });
  let reads = 0;
  await expect(
    evidence(f, p, () => {
      if (++reads > 1) throw new Error('revoked');
    }),
  ).rejects.toThrow('revoked');
  const other = { ...target(p), publicationSequence: 2, evidence: true };
  await expect(f.api.revision(f.prepared, other, f.recheck)).rejects.toThrow();
  f.objects.clear();
  await expect(evidence(f, p)).rejects.toThrow();
});

it('strictly scopes the separate evidence GET and rejects combinations with other reads', () => {
  const query = { publicationId: 'a'.repeat(64), publicationSequence: '1', evidence: '1' };
  expect(nativeRevisionQuery({ queryStringParameters: query }, 'publication')).toEqual({
    publicationId: 'a'.repeat(64),
    publicationSequence: 1,
    evidence: true,
  });
  for (const extra of [{ source: '1' }, { history: '1' }, { evidence: '2' }, { plan: 'express' }])
    expect(() =>
      nativeRevisionQuery({ queryStringParameters: { ...query, ...extra } }, 'publication'),
    ).toThrow();
  expect(() => nativeRevisionQuery({ queryStringParameters: query }, 'interaction')).toThrow();
});
