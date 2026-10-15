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
// and durably acknowledges them. Backpressure never evicts unacknowledged output.
// Nothing here is workflow authority: activity never approves or answers.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { createCliOutputSink } from '../output-normalizer.js';

import {
  NATIVE_ACTIVITY_LIMITS,
  nativePublicActivity,
  nativeUsageSummary,
  createNativeSecretGuard,
  FIELDS,
  applyMarks,
} from '../../shared/native-activity.js';
export {
  NATIVE_ACTIVITY_CAPABILITY,
  NATIVE_ACTIVITY_LIMITS,
  nativePublicActivity,
  createNativeSecretGuard,
  truncateUtf8,
  redactCredentialShapes,
} from '../../shared/native-activity.js';
const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');

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
    if (
      !fstatSync(fd).isFile() ||
      fstatSync(fd).size > NATIVE_ACTIVITY_LIMITS.segmentBytes + NATIVE_ACTIVITY_LIMITS.batchBytes
    )
      throw new Error('native_activity_spool_invalid');
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
export const readNativeActivitySpool = ({
  spoolDirectory,
  writerGeneration,
  after = 0,
  limits = NATIVE_ACTIVITY_LIMITS,
}) => {
  const events = [];
  let bytes = 0;
  let more = false;
  let closed = null;
  try {
    privateSpool(spoolDirectory);
    try {
      const fd = openSync(
        join(spoolDirectory, 'closed.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!fstatSync(fd).isFile() || fstatSync(fd).size > 1024)
          throw new Error('native_activity_spool_invalid');
        const value = JSON.parse(readFileSync(fd, 'utf8'));
        if (
          value.writerGeneration === writerGeneration &&
          Number.isSafeInteger(value.last) &&
          value.last >= after
        )
          closed = value;
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const name of readdirSync(spoolDirectory)
      .filter((entry) => SEGMENT.test(entry))
      .toSorted()) {
      for (const { record, bytes: size } of readSegment(join(spoolDirectory, name))) {
        if (record?.writerGeneration !== writerGeneration || !(record.index > after)) continue;
        if (
          events.length >= limits.batchEvents ||
          (events.length && bytes + size > limits.batchBytes)
        ) {
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
  const next = events.at(-1)?.index ?? after;
  return {
    writerGeneration,
    after,
    events,
    last: closed?.last ?? next,
    complete: Boolean(closed) && !more && next === closed.last,
    cold: true,
  };
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
  writeSpool = writeSync,
} = {}) => {
  if (!Number.isSafeInteger(writerGeneration) || writerGeneration < 1)
    throw Object.assign(new Error('native_execution_options_invalid'), {
      code: 'native_execution_options_invalid',
    });
  let nextIndex = 1;
  let acknowledged = 0;
  let delivered = 0;
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
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_APPEND,
        0o600,
      );
      segment = { path, fd, last: record.index, bytes: 0 };
      segments.push(segment);
    }
    const bytesToWrite = Buffer.from(`${line}\n`);
    try {
      let offset = 0;
      while (offset < bytesToWrite.length) {
        const written = writeSpool(segment.fd, bytesToWrite, offset, bytesToWrite.length - offset);
        if (!(written > 0)) throw new Error('native_activity_spool_write_failed');
        offset += written;
      }
    } catch (error) {
      // Retain all earlier complete records even after a partial/failed append.
      ftruncateSync(segment.fd, segment.bytes);
      throw error;
    }
    segment.last = record.index;
    segment.bytes += bytes;
    spoolBytes += bytes;
  };
  const spooling = () => Boolean(spoolDirectory) && !spoolFailed;
  // The cache is a contiguous window starting after the acknowledged cursor.
  const cacheEnd = () => cache.at(-1)?.record.index ?? acknowledged;
  const cacheRoom = (bytes) =>
    cache.length < limits.memoryEvents && cacheBytes + bytes <= limits.memoryBytes;
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
    acknowledged = Math.max(acknowledged, Math.min(cursor, delivered));
    while (cache.length && cache[0].record.index <= acknowledged) cacheBytes -= cache.shift().bytes;
    // Delete fully acknowledged segments, including the active one (a later
    // event opens a new segment).
    while (segments.length && segments[0].last <= acknowledged) removeSegment(segments.shift());
    // Refill the cache in order from the spool when it no longer reaches the
    // newest released event.
    // Pull merges retained disk segments with memory. A write failure stops
    // future disk writes, never reads of older unacknowledged disk records.
    if (!pressured() && waiters.length) {
      const resume = waiters;
      waiters = [];
      for (const resolve of resume) resolve();
    }
  };
  const turn = ({ sequence, harness, model, forbiddenBytes = [], signal, onObservation }) => {
    // The observer receives only numeric/closed-schema telemetry, never the
    // normalized text or raw harness event. A telemetry failure cannot stop work.
    const observe = (boundary, counts = {}) => {
      try {
        onObservation?.(boundary, counts);
      } catch {
        /* advisory */
      }
    };
    let usefulOutput = false;
    if (open) open.close({ failed: true });
    if (spoolDirectory) {
      try {
        unlinkSync(join(spoolDirectory, 'closed.json'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const guard = createNativeSecretGuard(forbiddenBytes);
    let pending = [];
    let flushTimer;
    // One stream per rendered field: the Raw view joins every event's content,
    // and each display field is rendered in order too. A credential split
    // across events is contiguous within its field's stream.
    const rawTail = Object.fromEntries(FIELDS.map((key) => [key, '']));
    let omittedDiagnostics = 0;
    let closed = false;
    const startedAt = now();
    let usageSamples = 0;
    const fieldOf = (event, key) => (key === 'content' ? event.content : event.display[key]) ?? '';
    const flush = (forced = false) => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!pending.length) return;
      const redacted = pending.map(() => ({}));
      for (const key of FIELDS) {
        const values = pending.map((event) => fieldOf(event, key));
        const combined = rawTail[key] + values.join('');
        const marks = guard.active ? guard.mark(combined) : null;
        if (forced && marks) {
          const tail = guard.risky(combined);
          if (tail) marks.fill(1, combined.length - tail);
        }
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
          guard.risky(
            (rawTail[key] + pending.map((item) => fieldOf(item, key)).join('')).slice(-8),
          ),
        );
      if (!risky || pending.length >= limits.heldEvents) flush(Boolean(risky));
      else if (!flushTimer) {
        flushTimer = setTimeout(() => flush(true), limits.flushMs);
        flushTimer.unref?.();
      }
    };
    const emitPublic = (value, kind = 'stdout') => {
      const event = nativePublicActivity(value, limits, guard);
      if (!event) {
        omittedDiagnostics++;
        return;
      }
      if (!usefulOutput && event.display.type !== 'system') {
        usefulOutput = true;
        observe('firstUsefulOutput');
      }
      push({ kind, capturedAt: now(), ...event });
    };
    let sink;
    let kiroLine = '';
    let kiroStreamed = false;
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
            if (record?.transport === 'kiro-acp-activity' && record.schemaVersion === 1) {
              kiroStreamed = true;
              emitPublic(record.event);
            } else if (
              !kiroStreamed &&
              record?.transport === 'kiro-acp' &&
              typeof record.text === 'string' &&
              record.text
            )
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
      sink = createCliOutputSink({
        cli: harness,
        retainState: false,
        maxPendingTools: 64,
        emit: (value) => emitPublic(value),
        onUsage: (metrics, event) => {
          if (harness === 'claude') {
            const counts = {};
            for (const [key, field] of Object.entries({
              durationMs: 'duration_ms',
              durationApiMs: 'duration_api_ms',
              numTurns: 'num_turns',
            })) {
              const value = event?.[field];
              if (
                Number.isSafeInteger(value) &&
                value >= 0 &&
                value <= (key === 'numTurns' ? 100000 : 86400000)
              )
                counts[key] = value;
            }
            observe('harnessUsageObserved', counts);
          }
          if (model === undefined) return;
          usageSamples++;
          emitPublic(
            {
              content: '',
              display: {
                type: 'system',
                title: `Turn ${sequence} · ${harness} · model ${model ?? 'unavailable'} · usage sample ${usageSamples}`,
                summary: nativeUsageSummary(metrics, model),
              },
            },
            'lifecycle',
          );
        },
      });
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
        flush(true);
        const event = nativePublicActivity(
          {
            content: '',
            display: { type: 'system', level, title, ...(summary ? { summary } : {}) },
          },
          limits,
          guard,
        );
        if (!event) return;
        append({
          sequence,
          kind: 'lifecycle',
          capturedAt: now(),
          ...event,
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
        if (model !== undefined)
          handle.lifecycle({
            title: `Turn ${sequence} · ${harness} · model ${model ?? 'unavailable'} · activity capture ended`,
            summary: `Capture wall time: ${Math.max(0, now() - startedAt)} ms (includes harness preparation and tools). ${
              usageSamples
                ? `${usageSamples} usage samples observed; aggregate cost unavailable.`
                : 'Usage and cost unavailable.'
            } This does not establish publication or workflow completion.`,
          });
        if (omittedDiagnostics)
          handle.lifecycle({
            title: `${omittedDiagnostics} unparsed harness output ${omittedDiagnostics === 1 ? 'entry was' : 'entries were'} withheld`,
          });
        if (failed)
          handle.lifecycle({
            level: 'error',
            title: 'Agent turn ended without a published response',
          });
        flush(true);
        closed = true;
        signal?.removeEventListener('abort', interrupted);
        const resume = waiters;
        waiters = [];
        for (const resolve of resume) resolve();
        if (open === handle) open = null;
        try {
          const segment = segments.at(-1);
          if (segment && segment.fd !== null) closeSegment(segment);
          if (spooling()) {
            ensureSpool();
            const temp = join(spoolDirectory, 'closed.tmp');
            const fd = openSync(
              temp,
              constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
              0o600,
            );
            try {
              writeSync(fd, JSON.stringify({ writerGeneration, last: nextIndex - 1 }));
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
            renameSync(temp, join(spoolDirectory, 'closed.json'));
            const directoryFd = openSync(spoolDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              fsyncSync(directoryFd);
            } finally {
              closeSync(directoryFd);
            }
          }
        } catch {
          spoolFailed = true;
        }
      },
    };
    const interrupted = () => handle.close({ failed: true });
    signal?.addEventListener('abort', interrupted, { once: true });
    open = handle;
    if (signal?.aborted) interrupted();
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
      const cursor = Number.isSafeInteger(after) && after >= 0 ? Math.min(after, delivered) : 0;
      acknowledge(cursor);
      const events = [];
      let bytes = 0;
      let expected = acknowledged + 1;
      const accept = ({ record, bytes: size }) => {
        if (record.index < expected) return true;
        if (record.index !== expected) return false;
        if (
          events.length >= limits.batchEvents ||
          (events.length && bytes + size > limits.batchBytes)
        )
          return false;
        events.push(structuredClone(record));
        bytes += size;
        expected++;
        return true;
      };
      // Segments precede the memory-only suffix, including after disk failure.
      let full = false;
      for (const segment of segments) {
        for (const entry of readSegment(segment.path)) {
          if (!accept(entry)) {
            full = true;
            break;
          }
        }
        if (full) break;
      }
      if (!full)
        for (const entry of cache) {
          if (!accept(entry)) break;
        }
      delivered = Math.max(delivered, events.at(-1)?.index ?? acknowledged);
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
