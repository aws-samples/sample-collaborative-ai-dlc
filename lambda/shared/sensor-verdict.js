// Resolve the EFFECTIVE detail of a sensor verdict — PURE + shared (no I/O).
//
// The two sensor kinds report their explanation at different depths:
//
//   - a `graph` sensor is evaluated once, in process, and its evaluator puts the
//     explanation at the TOP of `detail` — `{ reason, artifact, notApplicable }`;
//   - a `script` sensor runs once per matching file, so the runner AGGREGATES:
//     `{ files: [{ file, result, timedOut, detail }] }`, and the script's own
//     JSON (with its `reason`) sits on the per-file entry.
//
// Every consumer used to read the top level only, so a script sensor's FAIL
// reached the human as "Sensor X (gate) → FAIL" with no reason at all, even
// though the script had said exactly what was wrong. This module is the single
// place that resolves the shape, so the gate finding, the activity-feed note,
// the override audit row and the UI chip all say the same thing.
//
// Resolution order: the top level WINS whenever it carries any explanatory field
// (that is the `graph` shape, and the runner's own `{ error }` verdicts), and its
// reason is then returned exactly as stored, so those verdicts read the same as
// before. Only an aggregate-only detail falls through to `files[]`, and only the
// `reason` and `file` of an entry are read there. There the entry that
// explains the aggregate is the first one whose result equals it and that gives
// a reason; failing that, the first non-PASS entry that is not `notApplicable`,
// then the first non-PASS entry.
//
// `notApplicable` is deliberately NOT resolved from `files[]`. The runner sets
// it at the top level when nothing matched; a per-file flag is the script's own
// output, and letting it suppress a blocking FAIL at the gate would hand that
// decision to the script.

// Hard bound on a reason read from a per-file entry (and on the runner's error).
// A script sensor's `reason` is free text (e.g. a linter summary), and it is
// rendered inside a gate finding and written to an audit row, both of which stay
// readable only when it is bounded. Nothing is added to what the sensor emitted
// beyond the file it came from; long text is truncated, never reformatted.
const MAX_SENSOR_REASON_LENGTH = 500;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The fields that make a detail object an EXPLANATION rather than a bare
// aggregate. `error` is here because the runner emits `{ error }` verdicts of its
// own (no script, spawn failure, release integrity) and those must not be
// mistaken for "nothing at the top level".
const EXPLANATORY_KEYS = Object.freeze(['reason', 'artifact', 'error', 'notApplicable']);

const explains = (detail) =>
  isRecord(detail) && EXPLANATORY_KEYS.some((key) => detail[key] !== undefined);

const fileEntries = (detail) =>
  isRecord(detail) && Array.isArray(detail.files) ? detail.files.filter(isRecord) : [];

const text = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const bounded = (value) =>
  value.length <= MAX_SENSOR_REASON_LENGTH
    ? value
    : `${value.slice(0, MAX_SENSOR_REASON_LENGTH - 1)}…`;

// Resolve one verdict (or any `{ detail }` carrier) into the fields consumers
// read. Returns:
//   file      — the file path the reason came from, or null when it came from
//               the top level.
//   reason    — the effective reason: the top-level `reason` as stored, or a
//               per-file reason prefixed with its file and bounded. null when
//               absent.
//   error     — the top-level `error` (the runner's own), bounded, or null when
//               it is absent or not a string.
// Only `reason` and `file` are read from a per-file entry: every other key there
// is the script's own stdout, and none of it reaches a title, a note or a chip.
const resolveSensorVerdict = (verdict) => {
  const top = isRecord(verdict?.detail) ? verdict.detail : null;
  const error = typeof top?.error === 'string' && top.error ? bounded(top.error) : null;
  // An entry that only says "nothing to inspect here" explains nothing, and one
  // that timed out silently ahead of the file that failed must not hide it.
  const candidates = explains(top) ? [] : fileEntries(top).filter((row) => row.result !== 'PASS');
  const applicable = candidates.filter((row) => row.detail?.notApplicable !== true);
  const entry =
    applicable.find((row) => row.result === verdict?.result && text(row.detail?.reason)) ??
    applicable[0] ??
    candidates[0] ??
    null;
  if (!entry) {
    return { file: null, reason: top?.reason ?? null, error };
  }
  const file = text(entry.file);
  const reason = text(entry.detail?.reason);
  return {
    file,
    reason: reason ? bounded(file ? `${file}: ${reason}` : reason) : null,
    error,
  };
};

export { MAX_SENSOR_REASON_LENGTH, resolveSensorVerdict };
export default { MAX_SENSOR_REASON_LENGTH, resolveSensorVerdict };
