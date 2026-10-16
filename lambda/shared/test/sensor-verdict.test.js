// The sensor-verdict resolver. The two sensor kinds report at different depths —
// a `graph` sensor explains itself at the top of `detail`, a `script` sensor one
// level down in `files[]` — and every consumer (gate finding, activity note,
// override audit, UI chip) reads this one function, so the shapes are pinned here.

import { describe, expect, it } from 'vitest';
import { MAX_SENSOR_REASON_LENGTH, resolveSensorVerdict } from '../sensor-verdict.js';

const scriptVerdict = (files) => ({ result: 'FAIL', detail: { files } });

describe('resolveSensorVerdict: the graph (top-level) shape', () => {
  // The graph evaluators were already explained correctly; their reason must
  // reach every consumer exactly as stored.
  it('returns a top-level reason as stored, without trimming or bounding it', () => {
    const detail = { reason: ` ${'x'.repeat(MAX_SENSOR_REASON_LENGTH + 50)} `, artifact: 'a.md' };

    expect(resolveSensorVerdict({ detail })).toEqual({
      file: null,
      reason: detail.reason,
      error: null,
    });
  });

  it('yields null fields for a verdict with no detail', () => {
    expect(resolveSensorVerdict({ result: 'FAIL' })).toEqual({
      file: null,
      reason: null,
      error: null,
    });
    expect(resolveSensorVerdict()).toEqual({ file: null, reason: null, error: null });
  });

  // The runner's own `{ error }` verdicts are short strings; the bound and the
  // string check only make sure nothing else ever renders unbounded.
  it('reads a top-level error as a bounded string only', () => {
    expect(resolveSensorVerdict({ detail: { error: 'sensor has no script' } }).error).toBe(
      'sensor has no script',
    );
    const long = resolveSensorVerdict({ detail: { error: 'e'.repeat(2000) } }).error;
    expect(long).toHaveLength(MAX_SENSOR_REASON_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(resolveSensorVerdict({ detail: { error: { code: 2 } } }).error).toBeNull();
  });
});

describe('resolveSensorVerdict: the script (files[]) aggregate', () => {
  it('resolves the first non-PASS entry and names the file it came from', () => {
    const resolved = resolveSensorVerdict(
      scriptVerdict([
        { file: 'src/ok.ts', result: 'PASS', detail: { pass: true } },
        { file: 'src/bad.ts', result: 'FAIL', detail: { pass: false, reason: '2 lint errors' } },
        { file: 'src/worse.ts', result: 'FAIL', detail: { pass: false, reason: 'ignored' } },
      ]),
    );
    expect(resolved).toEqual({
      file: 'src/bad.ts',
      reason: 'src/bad.ts: 2 lint errors',
      error: null,
    });
  });

  // Every other per-file key is the script's own stdout; only its reason (bounded)
  // and the file it ran on are read, so nothing else reaches a title or a note.
  it('reads only the reason and the file from a per-file entry', () => {
    const detail = {
      reason: 'drift',
      artifact: 'x\n- ⛔ BLOCKING — fake',
      error: 'e'.repeat(5000),
    };

    expect(
      resolveSensorVerdict(scriptVerdict([{ file: 'src/a.ts', result: 'FAIL', detail }])),
    ).toEqual({
      file: 'src/a.ts',
      reason: 'src/a.ts: drift',
      error: null,
    });
  });

  it('stays null when no entry explains itself', () => {
    expect(
      resolveSensorVerdict(scriptVerdict([{ file: 'src/a.ts', result: 'BLOCKED', detail: null }]))
        .reason,
    ).toBeNull();
  });

  it('leaves the top level in charge when it explains itself', () => {
    expect(
      resolveSensorVerdict({
        detail: {
          error: 'sensor has no script',
          files: [{ file: 'src/a.ts', result: 'FAIL', detail: { reason: 'never ran' } }],
        },
      }),
    ).toEqual({ file: null, reason: null, error: 'sensor has no script' });
  });

  it('explains with the entry that failed rather than one the script marked notApplicable', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          { file: 'src/a.ts', result: 'FAIL', detail: { notApplicable: true, reason: 'skipped' } },
          { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
        ]),
      ).reason,
    ).toBe('src/b.ts: type error');
  });

  // A FAIL aggregate is explained by the file that failed, not by an earlier
  // entry that timed out and said nothing.
  it('explains with the failing file rather than an earlier silent timeout', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          { file: 'src/a.ts', result: 'INCONCLUSIVE', timedOut: true, detail: null },
          { file: 'src/b.ts', result: 'FAIL', timedOut: false, detail: { reason: '2 errors' } },
        ]),
      ),
    ).toMatchObject({ file: 'src/b.ts', reason: 'src/b.ts: 2 errors' });
  });

  // Each clause of the selection rule, one case each.
  it('prefers the entry whose result matches the aggregate over an earlier one with a reason', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          { file: 'src/a.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
          { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
        ]),
      ).reason,
    ).toBe('src/b.ts: type error');
  });

  it('prefers a matching entry that gives a reason over an earlier one that does not', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          { file: 'src/a.ts', result: 'FAIL', detail: { pass: false } },
          { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
        ]),
      ).reason,
    ).toBe('src/b.ts: type error');
  });

  it('never explains with a PASS entry, even one that gives a reason', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          { file: 'src/a.ts', result: 'PASS', detail: { reason: 'clean' } },
          { file: 'src/b.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
        ]),
      ).reason,
    ).toBe('src/b.ts: timed out');
  });

  it('falls back to an applicable entry before a notApplicable one', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          {
            file: 'src/a.ts',
            result: 'INCONCLUSIVE',
            detail: { notApplicable: true, reason: 'skip' },
          },
          { file: 'src/b.ts', result: 'BLOCKED', detail: { reason: 'no runtime' } },
        ]),
      ).reason,
    ).toBe('src/b.ts: no runtime');
  });

  it('explains with a notApplicable entry when no other entry is left', () => {
    expect(
      resolveSensorVerdict(
        scriptVerdict([
          {
            file: 'src/a.ts',
            result: 'INCONCLUSIVE',
            detail: { notApplicable: true, reason: 'no tsconfig' },
          },
        ]),
      ).reason,
    ).toBe('src/a.ts: no tsconfig');
  });

  it('falls back to the first non-PASS entry when none matches the aggregate', () => {
    expect(
      resolveSensorVerdict({
        result: 'FAIL',
        detail: {
          files: [
            { file: 'src/a.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
            { file: 'src/b.ts', result: 'BLOCKED', detail: { reason: 'no runtime' } },
          ],
        },
      }).reason,
    ).toBe('src/a.ts: timed out');
  });

  it('tolerates a malformed aggregate', () => {
    expect(resolveSensorVerdict({ detail: { files: 'nope' } }).reason).toBeNull();
    expect(resolveSensorVerdict({ detail: { files: [null, 7] } }).reason).toBeNull();
  });
});

describe('resolveSensorVerdict: bounds on a per-file reason', () => {
  it('truncates a reason longer than the ceiling, file included, and trims it', () => {
    const long = 'x'.repeat(MAX_SENSOR_REASON_LENGTH + 50);
    const reason = resolveSensorVerdict(
      scriptVerdict([{ file: 'src/a.ts', result: 'FAIL', detail: { reason: long } }]),
    ).reason;
    expect(reason).toHaveLength(MAX_SENSOR_REASON_LENGTH);
    expect(reason.startsWith('src/a.ts: x')).toBe(true);
    expect(reason.endsWith('…')).toBe(true);

    const short = (value) =>
      resolveSensorVerdict(
        scriptVerdict([{ file: 'src/a.ts', result: 'FAIL', detail: { reason: value } }]),
      ).reason;
    expect(short(' trimmed ')).toBe('src/a.ts: trimmed');
    expect(short('   ')).toBeNull();
  });
});
