// Incremental native activity for the shared Agent panel.
//
// Harness stdout is parsed by the SAME normalizer the platform uses
// (output-normalizer.js), then passed through a native public-output boundary
// before anything can leave the runtime:
//   - raw diagnostics are withheld (only a count is shown);
//   - tool payloads that touch private runtime paths are withheld;
//   - credential shapes and every forbidden credential value are redacted,
//     including fragments split across chunks, fields and events;
//   - fields are bounded and absolute workspace paths become project-relative.
// Released events wait in a bounded buffer until the trusted controller pulls
// and durably acknowledges them. Overflow is reported as an explicit gap.
// Nothing here is workflow authority: activity never approves or answers.
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createCliOutputSink } from '../output-normalizer.js';

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
});
const TYPES = new Set(['message', 'tool', 'edit', 'batch_read', 'artifact', 'question', 'system']);
const LEVELS = new Set(['info', 'success', 'warning', 'error']);
const PROJECT = '/mnt/native/project';
const REDACTED = '[REDACTED]';
// A secret window this long is treated as a credential fragment. Shorter runs
// at a boundary may leak at most HOLD - 1 characters before being held.
const GRAM = 12;
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
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `${REDACTED}`],
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
  CREDENTIAL_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);

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
    for (let i = 0; i + HOLD <= secret.length; i++) holdGrams.add(secret.slice(i, i + HOLD));
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
    risky: (text) => text.length >= HOLD && holdGrams.has(text.slice(-HOLD)),
  };
};

const FIELDS = ['content', 'title', 'summary', 'details'];
const applyMarks = (value, marks, offset) => {
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
export const nativePublicActivity = (event, limits = NATIVE_ACTIVITY_LIMITS) => {
  const display = event?.display ?? { type: 'message', level: 'info' };
  const rawContent = typeof event?.content === 'string' ? event.content : '';
  // Raw non-JSON diagnostics are not assistant or tool content. Errors keep
  // their own sanitized fields; everything else is withheld.
  if (display.type === 'raw' && display.level !== 'error') return null;
  const type = display.type === 'raw' ? 'system' : TYPES.has(display.type) ? display.type : 'message';
  const level = LEVELS.has(display.level) ? display.level : 'info';
  const fields = {
    content: rawContent,
    title: typeof display.title === 'string' ? display.title : undefined,
    summary: typeof display.summary === 'string' ? display.summary : undefined,
    details: typeof display.details === 'string' ? display.details : undefined,
  };
  const privateTouch = FIELDS.some((key) => fields[key] && PRIVATE_PATH.test(fields[key]));
  if (privateTouch && (toolLike(display, rawContent) || type === 'system')) {
    // Never forward a tool's input/output once it touches private state.
    const name = toolName(rawContent, display).replace(/[^A-Za-z0-9_.:-]/g, '');
    fields.content = `Running tool ${name}\n[Input and output withheld: private runtime path]\n`;
    fields.details = undefined;
    fields.summary = 'Private runtime content withheld';
  }
  const limit = { content: limits.contentBytes, title: limits.titleBytes, summary: limits.summaryBytes, details: limits.detailsBytes };
  for (const key of FIELDS) {
    if (fields[key] === undefined) continue;
    let value = fields[key].replace(ABSOLUTE_PRIVATE, PLACEHOLDER);
    value = redactCredentialShapes(relativize(value));
    value = truncateUtf8(value, limit[key]);
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

const SEGMENT = /^[0-9]{8}\.jsonl$/;
const privateSpool = (directory) => {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw Object.assign(new Error('native_activity_spool_invalid'), {
      code: 'native_activity_spool_invalid',
    });
};
const readSegment = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ record: JSON.parse(line), bytes: utf8Bytes(line) + 1 }));
  } finally {
    closeSync(fd);
  }
};

/**
 * Read a previous hot owner's durable spool after process loss. Only events
 * after the controller's cursor are returned; nothing is deleted here.
 */
export const readNativeActivitySpool = ({ spoolDirectory, writerGeneration, after = 0, limits = NATIVE_ACTIVITY_LIMITS }) => {
  const events = [];
  let bytes = 0;
  let more = false;
  try {
    privateSpool(spoolDirectory);
    for (const name of readdirSync(spoolDirectory).filter((entry) => SEGMENT.test(entry)).toSorted()) {
      for (const { record, bytes: size } of readSegment(join(spoolDirectory, name))) {
        if (record?.writerGeneration !== writerGeneration || !(record.index > after)) continue;
        if (events.length >= limits.batchEvents || (events.length && bytes + size > limits.batchBytes)) {
          more = true;
          break;
        }
        events.push(record);
        bytes += size;
      }
      if (more) break;
    }
  } catch {
    return null;
  }
  return { writerGeneration, after, events, last: events.at(-1)?.index ?? after, complete: false, cold: true };
};

/**
 * One log per hot writer generation. Released events are written through to a
 * private spool on the run's EFS control directory (bounded memory, retained
 * across process loss) and cached in memory for the controller's pulls. When
 * the spool reaches its bound, turn.write() returns a promise and the command
 * runner pauses the harness's stdout until the controller acknowledges more
 * events: real backpressure, never eviction and never a turn cutoff.
 */
export const createNativeActivityLog = ({
  writerGeneration,
  now = Date.now,
  limits = NATIVE_ACTIVITY_LIMITS,
  spoolDirectory = null,
} = {}) => {
  if (!Number.isSafeInteger(writerGeneration) || writerGeneration < 1)
    throw Object.assign(new Error('native_execution_options_invalid'), {
      code: 'native_execution_options_invalid',
    });
  let nextIndex = 1;
  let acknowledged = 0;
  let open = null;
  let spoolReady = false;
  let spoolFailed = false;
  let spoolBytes = 0;
  let segmentCounter = 0;
  const cache = [];
  let cacheBytes = 0;
  const segments = [];
  let waiters = [];
  const pressured = () =>
    spoolDirectory && !spoolFailed
      ? spoolBytes >= limits.spoolBytes || cacheBytes >= limits.memoryBytes * 2
      : cacheBytes >= limits.memoryBytes || cache.length >= limits.memoryEvents;
  const ensureSpool = () => {
    if (spoolReady) return;
    mkdirSync(spoolDirectory, { mode: 0o700 });
    privateSpool(spoolDirectory);
    spoolReady = true;
  };
  const closeSegment = (segment) => {
    if (segment.fd === null) return;
    try {
      fsyncSync(segment.fd);
    } finally {
      closeSync(segment.fd);
      segment.fd = null;
    }
  };
  const spool = (line, record, bytes) => {
    let segment = segments.at(-1);
    if (!segment || segment.fd === null || segment.bytes + bytes > limits.segmentBytes) {
      if (segment) closeSegment(segment);
      ensureSpool();
      const path = join(spoolDirectory, `${String(++segmentCounter).padStart(8, '0')}.jsonl`);
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND,
        0o600,
      );
      segment = { path, fd, last: record.index, bytes: 0 };
      segments.push(segment);
    }
    writeSync(segment.fd, `${line}\n`);
    segment.last = record.index;
    segment.bytes += bytes;
    spoolBytes += bytes;
  };
  const spooling = () => Boolean(spoolDirectory) && !spoolFailed;
  // The cache is a contiguous window starting after the acknowledged cursor.
  const cacheEnd = () => cache.at(-1)?.record.index ?? acknowledged;
  const cacheRoom = (bytes) => cache.length < limits.memoryEvents && cacheBytes + bytes <= limits.memoryBytes;
  const append = (event) => {
    const record = { index: nextIndex++, writerGeneration, ...event };
    const line = JSON.stringify(record);
    const bytes = utf8Bytes(line) + 1;
    if (spooling()) {
      try {
        spool(line, record, bytes);
      } catch {
        // Keep this and later events in memory; backpressure bounds that.
        spoolFailed = true;
      }
    }
    if (!spooling() || (cacheEnd() === record.index - 1 && cacheRoom(bytes))) {
      cache.push({ record, bytes });
      cacheBytes += bytes;
    }
  };
  const removeSegment = (segment) => {
    closeSegment(segment);
    spoolBytes -= segment.bytes;
    try {
      unlinkSync(segment.path);
    } catch {
      /* A leftover acknowledged segment is never re-sent: the cursor filters it. */
    }
  };
  const acknowledge = (cursor) => {
    acknowledged = Math.max(acknowledged, Math.min(cursor, nextIndex - 1));
    while (cache.length && cache[0].record.index <= acknowledged) cacheBytes -= cache.shift().bytes;
    // Delete fully acknowledged segments, including the active one (a later
    // event opens a new segment).
    while (segments.length && segments[0].last <= acknowledged) removeSegment(segments.shift());
    // Refill the cache in order from the spool when it no longer reaches the
    // newest released event.
    if (spooling() && cacheEnd() < nextIndex - 1) {
      for (const segment of segments) {
        if (segment.fd !== null) fsyncSync(segment.fd);
        let full = false;
        for (const entry of readSegment(segment.path)) {
          if (entry.record.index !== cacheEnd() + 1) continue;
          if (!cacheRoom(entry.bytes) && cache.length) {
            full = true;
            break;
          }
          cache.push(entry);
          cacheBytes += entry.bytes;
        }
        if (full) break;
      }
    }
    if (!pressured() && waiters.length) {
      const resume = waiters;
      waiters = [];
      for (const resolve of resume) resolve();
    }
  };
  const turn = ({ sequence, harness, forbiddenBytes = [] }) => {
    if (open) open.close({ failed: true });
    const guard = createNativeSecretGuard(forbiddenBytes);
    let pending = [];
    // One stream per rendered field: the Raw view joins every event's content,
    // and each display field is rendered in order too. A credential split
    // across events is contiguous within its field's stream.
    const rawTail = Object.fromEntries(FIELDS.map((key) => [key, '']));
    let omittedDiagnostics = 0;
    let closed = false;
    const fieldOf = (event, key) => (key === 'content' ? event.content : event.display[key]) ?? '';
    const flush = () => {
      if (!pending.length) return;
      const redacted = pending.map(() => ({}));
      for (const key of FIELDS) {
        const values = pending.map((event) => fieldOf(event, key));
        const combined = rawTail[key] + values.join('');
        const marks = guard.active ? guard.mark(combined) : null;
        let offset = rawTail[key].length;
        values.forEach((value, n) => {
          redacted[n][key] = marks ? applyMarks(value, marks, offset) : value;
          offset += value.length;
        });
        rawTail[key] = guard.tailLength ? combined.slice(-guard.tailLength) : '';
      }
      pending.forEach((event, n) => {
        const display = { ...event.display };
        for (const key of ['title', 'summary', 'details']) {
          if (redacted[n][key]) display[key] = redacted[n][key];
          else delete display[key];
        }
        append({
          sequence,
          kind: event.kind,
          capturedAt: event.capturedAt,
          content: redacted[n].content,
          display,
        });
      });
      pending = [];
    };
    const push = (event) => {
      if (closed) return;
      pending.push(event);
      // Hold while any field stream ends in text that could continue a secret.
      const risky =
        guard.active &&
        FIELDS.some((key) =>
          guard.risky((rawTail[key] + pending.map((item) => fieldOf(item, key)).join('')).slice(-8)),
        );
      if (!risky || pending.length >= limits.heldEvents) flush();
    };
    const emitPublic = (value, kind = 'stdout') => {
      const event = nativePublicActivity(value, limits);
      if (!event) {
        omittedDiagnostics++;
        return;
      }
      push({ kind, capturedAt: now(), ...event });
    };
    let sink;
    let kiroLine = '';
    if (harness === 'kiro') {
      // Native Kiro emits one ACP result record per turn; stream its text.
      sink = {
        write(chunk) {
          kiroLine += chunk;
          const lines = kiroLine.split('\n');
          kiroLine = lines.pop() ?? '';
          for (const line of lines) this.line(line);
        },
        line(line) {
          if (!line.trim()) return;
          try {
            const record = JSON.parse(line);
            if (record?.transport === 'kiro-acp' && typeof record.text === 'string' && record.text)
              emitPublic({ content: record.text, display: { type: 'message', level: 'info' } });
            else omittedDiagnostics++;
          } catch {
            omittedDiagnostics++;
          }
        },
        flush() {
          if (kiroLine) this.line(kiroLine);
          kiroLine = '';
        },
      };
    } else {
      sink = createCliOutputSink({ cli: harness, emit: (value) => emitPublic(value) });
    }
    const decoder = new TextDecoder('utf-8', { fatal: false });
    // Bound the partial line handed to the JSONL/ACP parsers. An oversized
    // line keeps only its prefix, which then fails to parse and is withheld.
    let lineChars = 0;
    let skippingLine = false;
    const bounded = (text) => {
      let out = '';
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf('\n', start);
        const piece = text.slice(start, newline === -1 ? text.length : newline);
        if (!skippingLine) {
          const room = limits.lineChars - lineChars;
          if (piece.length > room) {
            out += piece.slice(0, Math.max(0, room));
            skippingLine = true;
          } else {
            out += piece;
            lineChars += piece.length;
          }
        }
        if (newline === -1) break;
        out += '\n';
        lineChars = 0;
        skippingLine = false;
        start = newline + 1;
      }
      return out;
    };
    const handle = {
      /** Returns a promise while the harness's stdout must pause. */
      write(chunk) {
        if (closed) return undefined;
        try {
          sink.write(bounded(decoder.decode(chunk, { stream: true })));
        } catch {
          omittedDiagnostics++;
        }
        return pressured() ? new Promise((resolve) => waiters.push(resolve)) : undefined;
      },
      // Trusted fixed lifecycle text still flows through the same ordering.
      lifecycle({ title, level = 'info', summary }) {
        push({
          kind: 'lifecycle',
          capturedAt: now(),
          content: '',
          display: { type: 'system', level, title, ...(summary ? { summary } : {}) },
        });
      },
      close({ failed = false } = {}) {
        if (closed) return;
        try {
          sink.write(decoder.decode());
          sink.flush();
        } catch {
          omittedDiagnostics++;
        }
        if (omittedDiagnostics)
          push({
            kind: 'lifecycle',
            capturedAt: now(),
            content: '',
            display: {
              type: 'system',
              level: 'info',
              title: `${omittedDiagnostics} unparsed harness output ${omittedDiagnostics === 1 ? 'entry was' : 'entries were'} withheld`,
              hiddenByDefault: true,
            },
          });
        if (failed)
          push({
            kind: 'lifecycle',
            capturedAt: now(),
            content: '',
            display: { type: 'system', level: 'error', title: 'Agent turn ended without a published response' },
          });
        flush();
        closed = true;
        if (open === handle) open = null;
        try {
          const segment = segments.at(-1);
          if (segment && segment.fd !== null) fsyncSync(segment.fd);
        } catch {
          spoolFailed = true;
        }
      },
    };
    open = handle;
    return handle;
  };
  return {
    turn,
    get open() {
      return open !== null;
    },
    /**
     * After = the controller's durably ingested index for this generation.
     * complete is true only when no turn is open and this batch reaches the
     * last released event.
     */
    pull(after = 0) {
      const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
      acknowledge(cursor);
      const events = [];
      let bytes = 0;
      for (const { record, bytes: size } of cache) {
        if (record.index <= cursor) continue;
        if (events.length >= limits.batchEvents || (events.length && bytes + size > limits.batchBytes)) break;
        events.push(structuredClone(record));
        bytes += size;
      }
      const last = nextIndex - 1;
      const next = events.at(-1)?.index ?? Math.min(cursor, last);
      return {
        writerGeneration,
        after: cursor,
        events,
        last,
        complete: open === null && next >= last,
        ...(pressured() ? { pressure: true } : {}),
      };
    },
  };
};
