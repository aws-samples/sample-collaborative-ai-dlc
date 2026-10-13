// Public native activity contract shared by runtime sanitization and durable ingest.
import { costForMetrics } from './model-pricing.js';
export const NATIVE_ACTIVITY_CAPABILITY = 'activity-v1';
export const NATIVE_ACTIVITY_LIMITS = Object.freeze({
  contentBytes: 8 * 1024,
  detailsBytes: 8 * 1024,
  summaryBytes: 1024,
  titleBytes: 512,
  memoryEvents: 2000,
  memoryBytes: 4 * 1024 * 1024,
  segmentBytes: 1024 * 1024,
  spoolBytes: 256 * 1024 * 1024,
  lineChars: 1024 * 1024,
  batchEvents: 64,
  batchBytes: 160 * 1024,
  heldEvents: 32,
  flushMs: 80,
});
const TYPES = new Set(['message', 'tool', 'edit', 'batch_read', 'artifact', 'question', 'system']);
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const PROJECT = '/mnt/native/project';
const REDACTED = '[REDACTED]';
const USAGE_FIELDS = {
  tokensInput: 'input tokens',
  tokensOutput: 'output tokens',
  tokensCacheRead: 'cache-read tokens',
  tokensCacheWrite: 'cache-write tokens',
  tokensReasoning: 'reasoning tokens',
};

// Report samples, never infer a complete bill from a missing provider signal.
// Pricing uses the canonical resolver; this is an input/output estimate only.
export const nativeUsageSummary = (metrics, model) => {
  const observed = Object.fromEntries(
    Object.entries(metrics ?? {}).filter(
      ([key, value]) =>
        Object.hasOwn(USAGE_FIELDS, key) && Number.isSafeInteger(value) && value >= 0,
    ),
  );
  const fields = Object.entries(USAGE_FIELDS).map(
    ([key, label]) => `${label}: ${observed[key] ?? 'unavailable'}`,
  );
  const cost = costForMetrics(observed, model);
  const priced =
    Object.hasOwn(observed, 'tokensInput') &&
    Object.hasOwn(observed, 'tokensOutput') &&
    cost.priced;
  return [
    ...fields,
    priced
      ? `Input/output cost estimate: USD ${cost.totalCost.toFixed(6)} (canonical pricing; excludes cache, credits and infrastructure)`
      : 'Cost unavailable',
    'Provider-reported sample; total billing and reviewer attribution unavailable',
  ].join(' · ');
};
// A secret window this long is treated as a credential fragment. Shorter runs
// at a boundary may leak at most HOLD - 1 characters before being held.
const GRAM = 4;
const HOLD = 4;

const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');
export const truncateUtf8 = (value, maxBytes) => {
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = (omitted) => `\n… [${omitted} bytes omitted]`;
  const budget = maxBytes - utf8Bytes(suffix(9999999));
  let end = Math.max(0, Math.min(value.length, budget));
  while (end > 0 && utf8Bytes(value.slice(0, end)) > budget) end--;
  // Never split a surrogate pair.
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return `${value.slice(0, end)}${suffix(utf8Bytes(value) - utf8Bytes(value.slice(0, end)))}`;
};

// Paths whose contents belong to the runtime, harness homes, recovery state or
// the private project subset (see shared/native-project-files.js).
const PRIVATE_PATH =
  /(?:\/mnt\/native\/(?:\.native-control|machine|packages|package-downloads)(?![\w-])|\/home\/node(?![\w-])|(?<![\w.-])\/root(?![\w.-])|\/proc\/|\/run\/secrets|(?<![\w-])\.native-(?:control|homes)(?![\w-])|\.aidlc-sessions|steering-token-key|(?<![\w-])\.(?:codex|claude|kiro|opencode|agents|aidlc)\/|(?<![\w-])\.git\/(?:config|credentials|objects|index|HEAD|refs|hooks)|\.aidlc-engine\/\S*(?:lock|mutex|key))/;
const ABSOLUTE_PRIVATE =
  /(?:\/mnt\/native\/(?:\.native-control|machine|packages|package-downloads)|\/home\/node|(?<![\w.-])\/root(?=\/|\b)|\/proc|\/run\/secrets)[^\s"'`)\]}>,;]*/g;
const PLACEHOLDER = '‹private path›';

const CREDENTIAL_PATTERNS = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    `${REDACTED}`,
  ],
  [/\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, REDACTED],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    REDACTED,
  ],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, `$1 ${REDACTED}`],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  [
    /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|SESSION|PRIVATE_?KEY|AUTH)[A-Za-z0-9_]*)=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi,
    `$1=${REDACTED}`,
  ],
  [
    /("[A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|api_?key|access_?key|session|private_?key|authorization)[A-Za-z0-9_-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    `$1"${REDACTED}"`,
  ],
];
export const redactCredentialShapes = (value) =>
  CREDENTIAL_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    value,
  );

const relativize = (value) =>
  value
    .replaceAll(`${PROJECT}/`, '')
    .replace(new RegExp(`${PROJECT.replaceAll('/', '\\/')}(?![\\w/.-])`, 'g'), '.');

/**
 * Streaming guard for known credential values. Any window of GRAM characters
 * shared with a secret is redacted, across field and event boundaries. An
 * event whose tail could continue a secret is held until more output arrives.
 */
export const createNativeSecretGuard = (forbiddenBytes = []) => {
  const secrets = new Set();
  for (const value of forbiddenBytes) {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
    if (text.length < 6) continue;
    secrets.add(text);
    for (const encoded of [encodeURIComponent(text), JSON.stringify(text).slice(1, -1)])
      if (encoded !== text) secrets.add(encoded);
  }
  const windows = new Map();
  const holdGrams = new Set();
  for (const secret of secrets) {
    const width = Math.min(GRAM, secret.length);
    let grams = windows.get(width);
    if (!grams) windows.set(width, (grams = new Set()));
    for (let i = 0; i + width <= secret.length; i++) grams.add(secret.slice(i, i + width));
    for (let width = 1; width <= HOLD; width++)
      for (let i = 0; i + width <= secret.length; i++) holdGrams.add(secret.slice(i, i + width));
  }
  const tailLength = Math.max(0, ...windows.keys()) - 1;
  return {
    active: secrets.size > 0,
    tailLength: Math.max(0, tailLength),
    mark(text) {
      const marks = new Uint8Array(text.length);
      for (const [width, grams] of windows) {
        for (let i = 0; i + width <= text.length; i++) {
          if (grams.has(text.slice(i, i + width))) marks.fill(1, i, i + width);
        }
      }
      return marks;
    },
    risky: (text) => {
      for (let width = Math.min(HOLD, text.length); width > 0; width--)
        if (holdGrams.has(text.slice(-width))) return width;
      return 0;
    },
  };
};

export const FIELDS = ['content', 'title', 'summary', 'details'];
export const applyMarks = (value, marks, offset) => {
  let result = '';
  let redacting = false;
  for (let i = 0; i < value.length; i++) {
    if (marks[offset + i]) {
      if (!redacting) result += REDACTED;
      redacting = true;
    } else {
      redacting = false;
      result += value[i];
    }
  }
  return result;
};

const toolLike = (display, content) =>
  ['tool', 'edit', 'batch_read', 'artifact', 'question'].includes(display?.type) ||
  /^\s*Running tool\b/.test(content);
const toolName = (content, display) =>
  /^\s*Running tool\s+[`'"]?([A-Za-z0-9_.:-]{1,80})/.exec(content)?.[1] ??
  display?.title?.split(/[:\s]/)[0] ??
  'tool';

/**
 * Normalizer event -> bounded public fields, before the streaming secret guard.
 * Returns null for events that are never public (raw diagnostics).
 */
export const nativePublicActivity = (event, limits = NATIVE_ACTIVITY_LIMITS, guard = null) => {
  const display = event?.display ?? { type: 'message', level: 'info' };
  const rawContent = typeof event?.content === 'string' ? event.content : '';
  // Raw non-JSON diagnostics are not assistant or tool content. Errors keep
  // their own sanitized fields; everything else is withheld.
  if (display.type === 'raw' && display.level !== 'error') return null;
  const type =
    display.type === 'raw' ? 'system' : TYPES.has(display.type) ? display.type : 'message';
  const level = LEVELS.has(display.level) ? display.level : 'info';
  const fields = {
    content: rawContent,
    title: typeof display.title === 'string' ? display.title : undefined,
    summary: typeof display.summary === 'string' ? display.summary : undefined,
    details: typeof display.details === 'string' ? display.details : undefined,
  };
  const privateTouch = FIELDS.some((key) => fields[key] && PRIVATE_PATH.test(fields[key]));
  if (guard?.active) {
    const joined = FIELDS.map((key) => fields[key] ?? '').join('');
    const marks = guard.mark(joined);
    let offset = 0;
    for (const key of FIELDS) {
      const value = fields[key] ?? '';
      if (fields[key] !== undefined) fields[key] = applyMarks(value, marks, offset);
      offset += value.length;
    }
  }
  if (privateTouch && (toolLike(display, rawContent) || type === 'system')) {
    // Never forward a tool's input/output once it touches private state.
    const name = toolName(rawContent, display).replace(/[^A-Za-z0-9_.:-]/g, '');
    fields.content = `Running tool ${name}\n[Input and output withheld: private runtime path]\n`;
    fields.details = undefined;
    fields.summary = 'Private runtime content withheld';
  }
  const limit = {
    content: limits.contentBytes,
    title: limits.titleBytes,
    summary: limits.summaryBytes,
    details: limits.detailsBytes,
  };
  for (const key of FIELDS) {
    if (fields[key] === undefined) continue;
    // Redact before truncation: cutting a credential must not defeat matching.
    let value = guard?.active ? applyMarks(fields[key], guard.mark(fields[key]), 0) : fields[key];
    value = value.replace(ABSOLUTE_PRIVATE, PLACEHOLDER);
    value = redactCredentialShapes(relativize(value));
    value = truncateUtf8(value, limit[key]);
    if (guard?.active && value.includes('\n… [')) {
      const cut = value.indexOf('\n… [');
      const tail = guard.risky(value.slice(0, cut));
      if (tail)
        value = truncateUtf8(
          `${value.slice(0, cut - tail)}${REDACTED}${value.slice(cut)}`,
          limit[key],
        );
    }
    fields[key] = value;
  }
  if (!fields.content && !fields.title && !fields.summary) return null;
  return {
    content: fields.content,
    display: {
      type,
      level,
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.summary ? { summary: fields.summary } : {}),
      ...(fields.details ? { details: fields.details } : {}),
      ...(display.hiddenByDefault ? { hiddenByDefault: true } : {}),
    },
  };
};
