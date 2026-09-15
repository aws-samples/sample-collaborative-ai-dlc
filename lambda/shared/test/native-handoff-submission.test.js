import { describe, expect, it } from 'vitest';
import {
  MAX_HANDOFF_DOCUMENT_BYTES,
  validateHandoffDocuments,
} from '../native-handoff-submission.js';

const validDocuments = () => ({
  'code-generation-plan': {
    content: '# Plan\n\nImplement the unit.\n',
  },
  'code-summary': {
    content: '# Summary\n\nImplementation complete.\n',
  },
});

describe('validateHandoffDocuments', () => {
  it('accepts exactly the native plan and summary and hashes them', () => {
    const result = validateHandoffDocuments(validDocuments());
    expect(result.ok).toBe(true);
    expect(result.documents['code-generation-plan'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.documents['code-summary'].bytes).toBeGreaterThan(0);
  });

  it('accepts arbitrary workstation filenames and canonicalizes the result', () => {
    const documents = validDocuments();
    documents['code-generation-plan'].filename = 'plan.md';
    documents['code-summary'].filename = 'notes-from-agent.md';

    const result = validateHandoffDocuments(documents);

    expect(result.ok).toBe(true);
    expect(result.documents['code-generation-plan'].filename).toBe('code-generation-plan.md');
    expect(result.documents['code-summary'].filename).toBe('code-summary.md');
  });

  it('rejects missing, extra, empty, and oversized documents', () => {
    const missing = validDocuments();
    delete missing['code-summary'];
    expect(validateHandoffDocuments(missing).ok).toBe(false);

    const extra = { ...validDocuments(), memory: { filename: 'memory.md', content: 'x' } };
    expect(validateHandoffDocuments(extra).findings).toContainEqual(
      expect.objectContaining({ code: 'document_set_invalid' }),
    );

    const invalid = validDocuments();
    invalid['code-summary'] = {
      content: 'x'.repeat(MAX_HANDOFF_DOCUMENT_BYTES + 1),
    };
    expect(validateHandoffDocuments(invalid).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'content_too_large' })]),
    );
  });
});
