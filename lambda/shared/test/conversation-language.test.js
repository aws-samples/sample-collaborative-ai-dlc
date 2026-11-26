import { describe, it, expect } from 'vitest';
import {
  conversationLanguageLabel,
  describeConversationLanguageChange,
  normalizeConversationLanguage,
  parseStoredConversationLanguage,
  renderConversationLanguageBlock,
} from '../conversation-language.js';

describe('normalizeConversationLanguage', () => {
  it('resolves a plain language tag with English and native display names', () => {
    expect(normalizeConversationLanguage('ko')).toEqual({
      value: { tag: 'ko', englishName: 'Korean', nativeName: '한국어' },
    });
  });

  it('canonicalizes case and keeps the Region subtag', () => {
    const { value } = normalizeConversationLanguage('pt-br');
    expect(value.tag).toBe('pt-BR');
    expect(value.englishName).toBeTruthy();
    expect(value.nativeName).toBeTruthy();
  });

  it('accepts English like any other language', () => {
    expect(normalizeConversationLanguage('en').value).toEqual({
      tag: 'en',
      englishName: 'English',
      nativeName: 'English',
    });
  });

  it.each([null, undefined, '', '   '])('treats %j as an explicit unset', (raw) => {
    expect(normalizeConversationLanguage(raw)).toEqual({ value: null });
  });

  it('rejects a non-string value', () => {
    expect(normalizeConversationLanguage(42).error.code).toBe('conversation_language_invalid');
    expect(normalizeConversationLanguage(['ko']).error.code).toBe('conversation_language_invalid');
  });

  it('rejects a malformed tag', () => {
    expect(normalizeConversationLanguage('not a tag!').error.code).toBe(
      'conversation_language_invalid',
    );
  });

  it('rejects a well-formed tag that names no known language', () => {
    expect(normalizeConversationLanguage('xx').error.message).toContain(
      'does not name a known language',
    );
  });

  it.each(['zxx', 'mul', 'mul-Latn', 'und', 'mis'])(
    'rejects the special-purpose code %s, which names no language for prose',
    (tag) => {
      expect(normalizeConversationLanguage(tag).error.code).toBe('conversation_language_invalid');
    },
  );

  it('rejects extensions, variants and private-use tags', () => {
    for (const raw of ['en-US-x-foo', 'de-DE-1901', 'en-u-ca-buddhist']) {
      expect(normalizeConversationLanguage(raw).error.code).toBe('conversation_language_invalid');
    }
  });

  it('rejects an over-long value before canonicalization', () => {
    expect(normalizeConversationLanguage('a'.repeat(36)).error.message).toContain('at most');
  });
});

describe('parseStoredConversationLanguage', () => {
  it('parses the stored JSON and passes an already-parsed object through', () => {
    const stored = { tag: 'ko', englishName: 'Korean', nativeName: '한국어' };
    expect(parseStoredConversationLanguage(JSON.stringify(stored))).toEqual(stored);
    expect(parseStoredConversationLanguage(stored)).toEqual(stored);
  });

  it('treats absent, empty and malformed values as unset', () => {
    expect(parseStoredConversationLanguage(undefined)).toBeNull();
    expect(parseStoredConversationLanguage('')).toBeNull();
    expect(parseStoredConversationLanguage('{not json')).toBeNull();
    expect(parseStoredConversationLanguage('{"tag":""}')).toBeNull();
    expect(parseStoredConversationLanguage({ englishName: 'Korean' })).toBeNull();
  });
});

describe('conversationLanguageLabel', () => {
  it('pairs the English and native names, collapsing when they agree', () => {
    expect(
      conversationLanguageLabel({ tag: 'ko', englishName: 'Korean', nativeName: '한국어' }),
    ).toBe('Korean (한국어)');
    expect(
      conversationLanguageLabel({ tag: 'en', englishName: 'English', nativeName: 'English' }),
    ).toBe('English');
    expect(conversationLanguageLabel(null)).toBeNull();
  });
});

describe('renderConversationLanguageBlock', () => {
  it('renders nothing when unset, so existing prompts stay byte-identical', () => {
    expect(renderConversationLanguageBlock(null)).toBe('');
    expect(renderConversationLanguageBlock(undefined)).toBe('');
    expect(renderConversationLanguageBlock({ tag: 'ko' })).toBe('');
  });

  it('states the upstream conversation-language line and the self-contained English list', () => {
    const block = renderConversationLanguageBlock({
      tag: 'ko',
      englishName: 'Korean',
      nativeName: '한국어',
    });
    expect(block).toContain('## Conversation language');
    expect(block).toContain('Conversation language: Korean (한국어)');
    expect(block).toContain('Write all prose in Korean (한국어)');
    // The machine-read tokens the platform and upstream parse stay English.
    expect(block).toContain('`describe_changes`');
    expect(block).toContain('`## Positions`');
    expect(block).toContain('`**Collaborator:**`');
    expect(block).toContain('`units:`');
    expect(block).toContain('`[[slug]]`');
    expect(block).toContain('`X. Other (please specify)`');
    // Upstream's preserved tokens (v2.6.18 core/memory/org.md): literals the
    // engine compares, sensors match or reviewers emit.
    for (const token of [
      '`[Answer]:`',
      '`A. Accept assumptions`',
      '`B. Convert to follow-up questions`',
      '`None.`',
      '`## Sources`',
      '`## Assumptions & Open Questions`',
      '`## Assumption Confirmation`',
      '`## Review`',
      '`[desc]`',
      '`[memory:M<n>]`',
      '`Initial description:`',
      '`Workflow-selected scope:`',
      '`READY`',
      '`NOT-READY`',
      '`OBJECT:`',
      '`FR-1`',
      'mermaid keywords',
      'H2',
    ]) {
      expect(block).toContain(token);
    }
    // Headings are not prose to translate wholesale: template and sensor H2s
    // stay English.
    expect(block).not.toContain('artifact content and headings');
  });
});

describe('describeConversationLanguageChange', () => {
  const ko = { tag: 'ko', englishName: 'Korean', nativeName: '한국어' };
  const ja = { tag: 'ja', englishName: 'Japanese', nativeName: '日本語' };

  it('says nothing when the tag did not change', () => {
    expect(describeConversationLanguageChange({ previous: ko, next: ko })).toEqual([]);
    expect(describeConversationLanguageChange({ previous: null, next: null })).toEqual([]);
  });

  it('describes a set and a change', () => {
    expect(describeConversationLanguageChange({ previous: null, next: ko })).toEqual([
      'Conversation language set to Korean (한국어) for this intent',
    ]);
    expect(describeConversationLanguageChange({ previous: ko, next: ja })).toEqual([
      'Conversation language set to Japanese (日本語) for this intent',
    ]);
  });

  it('describes a clear with the value it removed', () => {
    expect(describeConversationLanguageChange({ previous: ko, next: null })).toEqual([
      'Conversation language override removed (was Korean (한국어))',
    ]);
  });
});
