import { describe, expect, it } from 'vitest';
import { FAILURE_SENTENCES, GENERIC_FAILURE_SENTENCE, describeFailure } from './failureReasons';

describe('describeFailure', () => {
  it('turns a known structured code into a plain sentence', () => {
    expect(describeFailure('not_implemented', 'mode pipeline')).toEqual({
      code: 'not_implemented',
      sentence: FAILURE_SENTENCES.not_implemented,
      technical: 'not_implemented: mode pipeline',
    });
  });

  it('recovers the stage and inner code from a legacy failureReason string', () => {
    const result = describeFailure(
      undefined,
      'stage_failed: reverse-engineering: not_implemented: mode pipeline',
    );
    expect(result).toEqual({
      code: 'not_implemented',
      stageId: 'reverse-engineering',
      sentence: FAILURE_SENTENCES.not_implemented,
      technical: 'stage_failed: reverse-engineering: not_implemented: mode pipeline',
    });
  });

  it('reads the stage from the failureReason when the code is the inner reason', () => {
    const result = describeFailure(
      'not_implemented',
      'stage_failed: reverse-engineering: not_implemented: mode pipeline',
    );
    expect(result.stageId).toBe('reverse-engineering');
    expect(result.technical).toBe(
      'stage_failed: reverse-engineering: not_implemented: mode pipeline',
    );
  });

  it('reads a run-level code that prefixes the message', () => {
    expect(describeFailure(null, 'init_ws_failed: clone refused')).toMatchObject({
      code: 'init_ws_failed',
      sentence: FAILURE_SENTENCES.init_ws_failed,
    });
  });

  it('falls back to a generic sentence and keeps the raw text as technical detail', () => {
    expect(describeFailure('brand_new_code', 'something odd')).toEqual({
      code: 'brand_new_code',
      sentence: GENERIC_FAILURE_SENTENCE,
      technical: 'brand_new_code: something odd',
    });
    expect(describeFailure()).toEqual({ sentence: GENERIC_FAILURE_SENTENCE, technical: '' });
    expect(describeFailure(undefined, 'Free text from somewhere')).toEqual({
      sentence: GENERIC_FAILURE_SENTENCE,
      technical: 'Free text from somewhere',
    });
  });

  it('writes every table entry as one plain sentence', () => {
    for (const [code, sentence] of Object.entries(FAILURE_SENTENCES)) {
      expect(sentence, code).toMatch(/^[A-Z][^_]*\.$/);
    }
  });
});
