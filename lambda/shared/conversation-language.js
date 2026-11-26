// Conversation language — the natural language a space (or one intent) chooses
// for agent-authored prose: artifacts, questions, answer options, summaries and
// review findings (#784).
//
// AI-DLC releases from v2.6.18 define how agents pick a language ("Conversation
// language — resolution" in core/memory/org.md): the orchestrator states a
// `Conversation language: <language>` line in every delegated brief and agents
// fall back to project memory, then the initial description, only when it is
// missing. On this platform the engine plays the orchestrator and, until this
// setting existed, never stated the line. The rendered block is deliberately
// SELF-CONTAINED — it restates what stays English rather than referring to the
// upstream protocol — because Claude and Kiro sessions do not load the rule
// stack (#800) and `current-stable` predates the protocol entirely.
//
// The contract:
//   - UNSET renders NOTHING, so every existing prompt stays byte-identical.
//   - The stored value is `{ tag, englishName, nativeName }`, resolved at write
//     time, so a rendered prompt never depends on the runtime's ICU data.
//   - The value is a canonicalized BCP 47 `language[-Script][-Region]` tag that
//     `Intl.DisplayNames` (with `fallback: 'none'`) can actually name; anything
//     else is rejected. English is a valid choice and renders like any other.

// language[-Script][-Region] after canonicalization. Extensions, variants and
// private-use tags are rejected: the setting names a human language for prose,
// not a full locale.
const CANONICAL_TAG_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-(?:[A-Z]{2}|\d{3}))?$/;

// Longest canonical language[-Script][-Region] form is 3+1+4+1+3 = 12; the cap
// only has to stop abuse before canonicalization runs.
const MAX_TAG_LENGTH = 35;

// Special-purpose codes `Intl.DisplayNames` still names ("No linguistic
// content", "Multiple languages") but that name no language to write prose in.
// `und`, `mis` and the private-use range are already unnamed.
const NON_LANGUAGE_CODES = new Set(['zxx', 'mul']);

const invalid = (message) => ({
  error: { code: 'conversation_language_invalid', message },
});

const displayName = (ofTag, inLocale) => {
  try {
    return (
      new Intl.DisplayNames([inLocale], { type: 'language', fallback: 'none' }).of(ofTag) ?? null
    );
  } catch {
    return null;
  }
};

// Normalize a caller-supplied conversation language. Returns
// `{ value: { tag, englishName, nativeName } }`, `{ value: null }` for an
// explicit unset (null/undefined/''), or `{ error: { code, message } }`.
// Run by every write path (space PUT, intent PATCH) so only resolvable tags are
// ever stored.
export const normalizeConversationLanguage = (raw) => {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  if (typeof raw !== 'string') {
    return invalid('conversationLanguage must be a BCP 47 language tag string or null');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null };
  if (trimmed.length > MAX_TAG_LENGTH) {
    return invalid(`conversationLanguage must be at most ${MAX_TAG_LENGTH} characters`);
  }
  let tag;
  try {
    [tag] = Intl.getCanonicalLocales(trimmed);
  } catch {
    return invalid(`"${trimmed}" is not a well-formed BCP 47 language tag`);
  }
  if (!tag || !CANONICAL_TAG_PATTERN.test(tag)) {
    return invalid(
      `conversationLanguage must be a language[-Script][-Region] tag such as "ko", "ja" or "pt-BR"`,
    );
  }
  const englishName = NON_LANGUAGE_CODES.has(tag.split('-')[0]) ? null : displayName(tag, 'en');
  if (!englishName) {
    return invalid(`"${tag}" does not name a known language`);
  }
  const nativeName = displayName(tag, tag) ?? englishName;
  return { value: { tag, englishName, nativeName } };
};

// Parse a stored conversation language: the JSON of the resolved
// { tag, englishName, nativeName } a write path persisted, '' or absent when
// unset. Tolerant of malformed rows — an unreadable value means unset, never a
// failed read.
export const parseStoredConversationLanguage = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') {
    return typeof raw.tag === 'string' && raw.tag ? raw : null;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.tag === 'string' && parsed.tag ? parsed : null;
  } catch {
    return null;
  }
};

// `Korean (한국어)`, collapsing to `English` when both names agree.
export const conversationLanguageLabel = (language) => {
  if (!language?.englishName) return null;
  return language.nativeName && language.nativeName !== language.englishName
    ? `${language.englishName} (${language.nativeName})`
    : language.englishName;
};

// Render the conversation-language block stated in every lead and persona
// prompt. PURE; '' when unset so prompts without the setting are unchanged.
//
// What must stay English is restated here because the block is the only place
// the instruction reaches every CLI (see the header note on #800). The list
// covers the platform's own machine-read tokens and restates upstream's
// "Conversation language — preserved tokens" (v2.6.18 core/memory/org.md):
// engine-compared answers and sentinels, sensor-matched headings, register
// tags and verdicts. Keys/ids/enums keep structured blocks parseable, and the
// catch-all option literal keeps the question UI's English-worded catch-all
// detection working (QuestionEditor injects its own free-text "Other"
// otherwise). Prose headings an agent writes itself follow the language.
export const renderConversationLanguageBlock = (language) => {
  const label = conversationLanguageLabel(language);
  if (!label) return '';
  return [
    '## Conversation language',
    '',
    `Conversation language: ${label}`,
    '',
    `Write all prose in ${label}: artifact content, questions and their answer`,
    'options, summaries, review findings and explanations. Localize the prose',
    'around a fixed token, never the token itself.',
    '',
    'The following stay in English exactly as specified, regardless of the',
    'conversation language:',
    '',
    '- code, identifiers, file paths, branch names, mermaid keywords and',
    '  cross-references;',
    '- the commit description passed to `describe_changes`;',
    '- keys, ids and enumerated values in fenced YAML or JSON blocks and in tool',
    '  parameters (prose-valued fields such as descriptions follow the',
    '  conversation language); in `units:` blocks, the `name`, `kind` and',
    '  `depends_on` values;',
    '- stable IDs such as `FR-1`, `ENT-001` and `BR1.1`;',
    '- `[Answer]:` tags with their option letters, the catch-all answer option',
    '  `X. Other (please specify)`, and the assumption-confirmation options',
    '  `A. Accept assumptions` and `B. Convert to follow-up questions`;',
    '- the `None.` and `None` sentinels;',
    '- the headings `## Sources`, `## Assumptions & Open Questions`,',
    '  `## Assumption Confirmation`, `## Review` and `## Positions`, and any H2',
    '  heading taken from a stage template;',
    '- the source-register tags `[desc]`, `[scope]`, `[assumption]`, `[Q<n>]` and',
    '  `[memory:M<n>]`, with their prefixes `Initial description:` and',
    '  `Workflow-selected scope:`;',
    '- the reviewer verdicts `READY` and `NOT-READY`;',
    '- the collaboration tokens `AGREE:`, `OBJECT:`, `OBJECT (knowledge):`,',
    '  `OBJECT (judgment):`, `**Collaborator:**` and `**Reviewer:**`;',
    '- the field labels, status values and checkbox states of `aidlc-state.md`;',
    '- artifact slugs and `[[slug]]` links;',
    '- any other literal your instructions say to write exactly.',
  ].join('\n');
};

// One plain-language timeline line for a per-intent change, mirroring
// `describeAidlcSettingsChange`. The actor is supplied by the caller — the
// authenticated member whose write produced the change.
export const describeConversationLanguageChange = ({ previous = null, next = null } = {}) => {
  if ((previous?.tag ?? null) === (next?.tag ?? null)) return [];
  // The equality guard above already answered null→null, so a missing `next`
  // here always removes a recorded value.
  if (!next) {
    return [`Conversation language override removed (was ${conversationLanguageLabel(previous)})`];
  }
  return [`Conversation language set to ${conversationLanguageLabel(next)} for this intent`];
};
