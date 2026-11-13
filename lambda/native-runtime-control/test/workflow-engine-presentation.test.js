import { describe, expect, it } from 'vitest';
import { buildNativePendingInput } from '../../shared/native-pending-input.js';
import { engineDigest } from '../../shared/native-workflow-protocol.js';
import {
  nativeEnginePresentation,
  assertNativeEnginePresentedQuestion,
} from '../workflow-engine/presentation.js';

const prompt = 'Approve the verification command for the inspected application?';
const fixture = () => ({
  state: {
    directive: { kind: 'run-stage', stage: 'code-generation', gate: true },
    requirements: [],
  },
  observed: {
    workflow: { currentStage: 'code-generation' },
    protectedQuestion: {
      challengeId: 'a'.repeat(32),
      targetSha256: 'b'.repeat(64),
      promptDigest: engineDigest(prompt),
      options: ['Approve', 'Request Changes'],
    },
  },
  interaction: {
    id: 'c'.repeat(64),
    contentSha256: 'd'.repeat(64),
    publicationId: 'e'.repeat(64),
    sequence: 3,
    pendingInput: buildNativePendingInput({
      spec: {
        version: 2,
        questions: [
          {
            prompt,
            options: [{ label: 'Approve' }, { label: 'Request Changes' }],
          },
        ],
      },
    }),
  },
});
describe('a displayed native decision names its protected engine question', () => {
  it('binds the exact question, options, target and published interaction', () => {
    const f = fixture();
    const presented = nativeEnginePresentation(f.state, f.observed, f.interaction);
    expect(presented).toMatchObject({
      interactionId: f.interaction.id,
      publicationId: f.interaction.publicationId,
      question: f.observed.protectedQuestion,
      directive: { kind: 'protected-question', stage: 'code-generation' },
    });
    expect(() => assertNativeEnginePresentedQuestion(f.observed, presented)).not.toThrow();
  });
  it.each(['prompt', 'options'])(
    'rejects another %s even when its approval label is identical',
    (field) => {
      const f = fixture();
      if (field === 'prompt')
        f.interaction.pendingInput.questions[0].prompt = 'Approve a different policy?';
      else f.interaction.pendingInput.questions[0].options.reverse();
      expect(() => nativeEnginePresentation(f.state, f.observed, f.interaction)).toThrow(
        'NATIVE_ENGINE_PRESENTATION_MISMATCH',
      );
    },
  );
  it.each(['targetSha256', 'challengeId', 'missing'])(
    'refuses a reply when the protected %s changed after presentation',
    (field) => {
      const f = fixture();
      const presented = nativeEnginePresentation(f.state, f.observed, f.interaction);
      if (field === 'missing') f.observed.protectedQuestion = null;
      else f.observed.protectedQuestion = { ...f.observed.protectedQuestion, [field]: 'changed' };
      expect(() => assertNativeEnginePresentedQuestion(f.observed, presented)).toThrow(
        'NATIVE_ENGINE_PRESENTATION_MISMATCH',
      );
    },
  );
  it('does not reuse an ordinary authored answer for a newly minted policy question', () => {
    const f = fixture();
    expect(() => assertNativeEnginePresentedQuestion(f.observed, { question: null })).toThrow(
      'NATIVE_ENGINE_PRESENTATION_MISMATCH',
    );
  });
});
