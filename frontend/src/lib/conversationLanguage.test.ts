import { describe, expect, it } from 'vitest';
import { resolveConversationLanguage } from './conversationLanguage';

describe('resolveConversationLanguage', () => {
  it('resolves a language the backend accepts', () => {
    expect(resolveConversationLanguage('ko')).toMatchObject({
      value: { tag: 'ko', englishName: 'Korean' },
    });
  });

  it.each(['zxx', 'mul', 'mul-Latn', 'und'])(
    'rejects %s like the backend, which names no language for prose',
    (tag) => {
      expect(resolveConversationLanguage(tag)).toHaveProperty('error');
    },
  );
});
