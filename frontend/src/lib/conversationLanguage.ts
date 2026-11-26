// Conversation language (#784) — client-side mirror of the backend's
// lambda/shared/conversation-language.js normalization, for live preview and
// pre-submit validation. The backend remains the authority: it re-resolves the
// tag on every write.

import type { ConversationLanguage } from '@/services/projects';

// language[-Script][-Region] after canonicalization; extensions, variants and
// private-use tags are rejected (the setting names a human language, not a
// full locale).
const CANONICAL_TAG_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-(?:[A-Z]{2}|\d{3}))?$/;
const MAX_TAG_LENGTH = 35;

const displayName = (ofTag: string, inLocale: string): string | null => {
  try {
    return (
      new Intl.DisplayNames([inLocale], { type: 'language', fallback: 'none' }).of(ofTag) ?? null
    );
  } catch {
    return null;
  }
};

// null for an empty input (= unset), a resolved value, or an error string.
// Mirrors lambda/shared/conversation-language.js: codes Intl still names but
// that name no language to write prose in.
const NON_LANGUAGE_CODES = new Set(['zxx', 'mul']);

export const resolveConversationLanguage = (
  raw: string,
): { value: ConversationLanguage | null } | { error: string } => {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_TAG_LENGTH) {
    return { error: `Must be at most ${MAX_TAG_LENGTH} characters` };
  }
  let tag: string | undefined;
  try {
    [tag] = Intl.getCanonicalLocales(trimmed);
  } catch {
    return { error: `"${trimmed}" is not a well-formed BCP 47 language tag` };
  }
  if (!tag || !CANONICAL_TAG_PATTERN.test(tag)) {
    return { error: 'Use a language[-Script][-Region] tag such as "ko", "ja" or "pt-BR"' };
  }
  const englishName = NON_LANGUAGE_CODES.has(tag.split('-')[0]) ? null : displayName(tag, 'en');
  if (!englishName) return { error: `"${tag}" does not name a known language` };
  const nativeName = displayName(tag, tag) ?? englishName;
  return { value: { tag, englishName, nativeName } };
};

// `Korean (한국어)`, collapsing to `English` when both names agree.
export const conversationLanguageLabel = (
  language: ConversationLanguage | null | undefined,
): string | null => {
  if (!language?.englishName) return null;
  return language.nativeName && language.nativeName !== language.englishName
    ? `${language.englishName} (${language.nativeName})`
    : language.englishName;
};
