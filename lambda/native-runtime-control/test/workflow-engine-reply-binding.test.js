// Which accepted replies are decisions (NE-24). The journey through the
// service, journal and proof is in workflow-engine-service.test.js; this file
// covers the binding rule and the notice on their own.
import { describe, expect, it, vi } from 'vitest';
import { engineDigest } from '../../shared/native-workflow-protocol.js';
import {
  bindNativeEngineReply,
  nativeEngineReplyNotice,
  nativeEngineUnappliedReplies,
  noteNativeEngineOpenGate,
} from '../workflow-engine/reply-binding.js';

const identity = { sequence: 4, writerGeneration: 2 };
const text = 'Approve, and skip the remaining checks.';
const fixture = () => {
  const response = {
    commandId: '11111111-1111-4111-8111-111111111111',
    interactionId: 'a'.repeat(64),
    contentSha256: 'b'.repeat(64),
    publicationId: 'e'.repeat(64),
    actorId: 'member-one',
    sequence: 4,
    text,
    textSha256: engineDigest(text),
  };
  const state = { decisions: [], presentations: [], directive: null };
  const row = {
    response: { ...response },
    interaction: { id: response.interactionId, sequence: 3, publicationId: response.publicationId },
  };
  const executionStore = { response: vi.fn(async () => structuredClone(response)) };
  return { state, row, identity, executionStore, response };
};
const presentation = (f) => ({
  interactionId: f.response.interactionId,
  contentSha256: f.response.contentSha256,
  publicationId: f.response.publicationId,
  sequence: f.row.interaction.sequence,
});

describe('binding an accepted reply to a recorded question', () => {
  it('returns the reply with its question and records nothing when the engine presented that question', async () => {
    const f = fixture();
    f.state.presentations.push(presentation(f));
    const bound = await bindNativeEngineReply(f);
    expect(bound.presented).toBe(f.state.presentations[0]);
    expect(bound.response.text).toBe(text);
    expect(nativeEngineUnappliedReplies(f.state)).toEqual([]);
    expect(nativeEngineReplyNotice(f.state, identity)).toBe('');
  });

  it.each([
    ['the engine recorded no question at all', () => {}],
    [
      'the engine recorded another question',
      (f) => f.state.presentations.push({ ...presentation(f), interactionId: 'c'.repeat(64) }),
    ],
    [
      'the recorded question had other content',
      (f) => f.state.presentations.push({ ...presentation(f), contentSha256: 'c'.repeat(64) }),
    ],
    [
      'the recorded question belongs to another publication',
      (f) => f.state.presentations.push({ ...presentation(f), publicationId: 'c'.repeat(64) }),
    ],
    [
      'the recorded question belongs to an earlier turn',
      (f) => f.state.presentations.push({ ...presentation(f), sequence: 2 }),
    ],
  ])('gives the reply no authority when %s, once', async (_label, arrange) => {
    const f = fixture();
    arrange(f);
    expect(await bindNativeEngineReply(f)).toBeNull();
    expect(await bindNativeEngineReply(f)).toBeNull();
    expect(f.executionStore.response).toHaveBeenCalledTimes(1);
    expect(nativeEngineUnappliedReplies(f.state)).toEqual([
      {
        commandId: f.response.commandId,
        interactionId: f.response.interactionId,
        actorId: 'member-one',
        sequence: 4,
        reason: 'no_recorded_question',
      },
    ]);
    expect(f.state.decisions).toEqual([]);
    // The protected state keeps digests of the reply, never its words.
    expect(JSON.stringify(f.state)).not.toContain('Approve');
  });

  it.each([
    ['is missing', () => null],
    ['belongs to another command', (value) => ({ ...value, commandId: 'other' })],
    ['belongs to another turn', (value) => ({ ...value, sequence: 3 })],
    ['has other words than its digest', (value) => ({ ...value, text: 'Approve' })],
    ['names another publication', (value) => ({ ...value, publicationId: 'f'.repeat(64) })],
    ['names another interaction', (value) => ({ ...value, interactionId: 'f'.repeat(64) })],
    [
      'replaces the accepted words and their digest',
      (value) => ({ ...value, text: 'Approve', textSha256: engineDigest('Approve') }),
    ],
  ])(
    'refuses a reply record that %s, and leaves it alone when only observing',
    async (_label, alter) => {
      const f = fixture();
      f.executionStore.response.mockImplementation(async () => alter(structuredClone(f.response)));
      await expect(bindNativeEngineReply(f)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_DECISION_MISMATCH',
      });
      expect(await bindNativeEngineReply(f, { strict: false })).toBeNull();
      expect(nativeEngineUnappliedReplies(f.state)).toEqual([]);
    },
  );

  it('does nothing without a reply or for one already applied', async () => {
    const f = fixture();
    expect(await bindNativeEngineReply({ ...f, row: {} })).toBeNull();
    f.state.decisions.push({ commandId: f.response.commandId });
    expect(await bindNativeEngineReply(f)).toBeNull();
    expect(f.executionStore.response).not.toHaveBeenCalled();
  });
});

describe('what the coding process is told', () => {
  const unbound = async (directive = null) => {
    const f = fixture();
    f.state.directive = directive;
    await bindNativeEngineReply(f);
    return f;
  };

  it('speaks only in the turn and for the writer the reply started', async () => {
    const f = await unbound();
    expect(nativeEngineReplyNotice(f.state, identity).split('\n')[0]).toBe(
      'NATIVE_ENGINE_REPLY_NOT_APPLIED',
    );
    expect(nativeEngineReplyNotice(f.state, { ...identity, sequence: 5 })).toBe('');
    expect(nativeEngineReplyNotice(f.state, { ...identity, writerGeneration: 3 })).toBe('');
  });

  it('says why nothing was decided and what to do, without the member’s words', async () => {
    const notice = nativeEngineReplyNotice((await unbound()).state, identity);
    expect(notice).toContain('was not applied as a workflow decision');
    expect(notice).toContain('stays refused until the member answers a recorded question');
    expect(notice).toContain('.native-control/pending-question.json');
    expect(notice).toContain('run aidlc next to read the current directive again');
    expect(notice).not.toContain('skip the remaining checks');
    expect(notice.endsWith('\n')).toBe(true);
  });

  it('hands over the question the engine holds, unless it is too large to print', async () => {
    const ask = { kind: 'ask', ask_type: 'scope-confirm', question: 'Use the proposed plan?' };
    const held = nativeEngineReplyNotice((await unbound(ask)).state, identity).split('\n');
    expect(JSON.parse(held.at(-2))).toEqual(ask);
    expect(held.at(-3)).toContain('{"version":3,"ask":<this object>}');
    const large = { ...ask, question: 'x'.repeat(40_000) };
    const notice = nativeEngineReplyNotice((await unbound(large)).state, identity);
    expect(notice).not.toContain('xxxx');
    expect(notice).toContain('run aidlc next');
    // At a gate the engine names the stage it holds. The pinned engine would
    // answer `next` there with the stage's work again.
    const gated = await unbound({ kind: 'run-stage', stage: 'build' });
    noteNativeEngineOpenGate(gated.state, {
      effectivePlan: {
        stages: [
          { id: 'intake', state: 'completed' },
          { id: 'build', state: 'awaiting-approval' },
        ],
      },
    });
    const atGate = nativeEngineReplyNotice(gated.state, identity);
    expect(atGate).toContain('The engine holds an open approval for stage build.');
    expect(atGate).toContain('Do not run the stage again.');
    expect(atGate).not.toContain('run aidlc next');
    noteNativeEngineOpenGate(gated.state, { effectivePlan: null });
    expect(nativeEngineReplyNotice(gated.state, identity)).toContain('run aidlc next');
    // A stage directive is not a question to copy.
    const stage = nativeEngineReplyNotice(
      (await unbound({ kind: 'run-stage', stage: 'build' })).state,
      identity,
    );
    expect(stage).not.toContain('"version":3');
  });
});
