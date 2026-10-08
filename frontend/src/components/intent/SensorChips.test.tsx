import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SensorChips, summarizeSensorDetail } from './SensorChips';
import type { IntentSensorRun, SensorDetail } from '@/services/intents';

const run = (over: Partial<IntentSensorRun> = {}): IntentSensorRun =>
  ({
    sensorRunId: 'sr-1',
    sensorId: 'linter',
    result: 'FAIL',
    severity: 'blocking',
    held: true,
    detail: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as IntentSensorRun;

describe('summarizeSensorDetail', () => {
  it('explains a graph sensor from the top level', () => {
    expect(summarizeSensorDetail({ reason: 'unsourced claim' })).toBe('unsourced claim');
    expect(summarizeSensorDetail({ error: 'sensor has no script' })).toBe('sensor has no script');
    expect(summarizeSensorDetail({ unreferenced: ['design'] })).toBe('unreferenced: design');
    expect(summarizeSensorDetail(null)).toBeNull();
  });

  // A script sensor runs once per matching file, so its reason sits on the entry.
  it("explains a script sensor from the failing file's entry", () => {
    expect(
      summarizeSensorDetail({
        files: [
          { file: 'src/ok.ts', result: 'PASS', detail: { pass: true } },
          { file: 'src/app.ts', result: 'FAIL', detail: { reason: '2 problems' } },
        ],
      }),
    ).toBe('src/app.ts: 2 problems');
  });

  it('skips a notApplicable entry in favour of the one that failed', () => {
    expect(
      summarizeSensorDetail({
        files: [
          { file: 'src/a.ts', result: 'INCONCLUSIVE', detail: { notApplicable: true } },
          { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
        ],
      }),
    ).toBe('src/b.ts: type error');
  });

  it('explains with the failing file rather than an earlier silent timeout', () => {
    expect(
      summarizeSensorDetail(
        {
          files: [
            { file: 'src/a.ts', result: 'INCONCLUSIVE', timedOut: true, detail: null },
            { file: 'src/b.ts', result: 'FAIL', timedOut: false, detail: { reason: '2 errors' } },
          ],
        },
        'FAIL',
      ),
    ).toBe('src/b.ts: 2 errors');
  });

  // Each clause of the selection rule, one case each (the same cases as
  // lambda/shared/test/sensor-verdict.test.js).
  type Files = NonNullable<SensorDetail['files']>;
  const pick = (files: Files) => summarizeSensorDetail({ files }, 'FAIL');

  it('prefers the entry whose result matches the run over an earlier one with a reason', () => {
    expect(
      pick([
        { file: 'src/a.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
        { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
      ]),
    ).toBe('src/b.ts: type error');
  });

  it('prefers a matching entry that gives a reason over an earlier one that does not', () => {
    expect(
      pick([
        { file: 'src/a.ts', result: 'FAIL', detail: {} },
        { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } },
      ]),
    ).toBe('src/b.ts: type error');
  });

  it('never explains with a PASS entry, even one that gives a reason', () => {
    expect(
      pick([
        { file: 'src/a.ts', result: 'PASS', detail: { reason: 'clean' } },
        { file: 'src/b.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
      ]),
    ).toBe('src/b.ts: timed out');
  });

  it('falls back to an applicable entry before a notApplicable one', () => {
    expect(
      pick([
        {
          file: 'src/a.ts',
          result: 'INCONCLUSIVE',
          detail: { notApplicable: true, reason: 'skip' },
        },
        { file: 'src/b.ts', result: 'BLOCKED', detail: { reason: 'no runtime' } },
      ]),
    ).toBe('src/b.ts: no runtime');
  });

  it('explains with a notApplicable entry when no other entry is left', () => {
    expect(
      pick([
        {
          file: 'src/a.ts',
          result: 'INCONCLUSIVE',
          detail: { notApplicable: true, reason: 'no tsconfig' },
        },
      ]),
    ).toBe('src/a.ts: no tsconfig');
  });

  it('skips a null entry', () => {
    const files = [null, { file: 'src/b.ts', result: 'FAIL', detail: { reason: 'type error' } }];
    expect(pick(files as unknown as Files)).toBe('src/b.ts: type error');
  });

  // Only the reason is read from the script's per-file JSON.
  it("shows nothing of a script's own per-file error or unreferenced list", () => {
    const error = { code: 2 } as unknown as string;
    expect(pick([{ file: 'src/a.ts', result: 'FAIL', detail: { error } }])).toBeNull();
    expect(
      pick([{ file: 'src/a.ts', result: 'FAIL', detail: { unreferenced: ['x'] } }]),
    ).toBeNull();
  });

  it('shows a top-level error as a bounded string only', () => {
    expect(summarizeSensorDetail({ error: 'e'.repeat(2000) })).toHaveLength(500);
    expect(summarizeSensorDetail({ error: { code: 2 } as unknown as string })).toBeNull();
  });

  it('leaves the top level in charge when it explains itself', () => {
    expect(
      summarizeSensorDetail({
        error: 'release script digest mismatch',
        files: [{ file: 'src/a.ts', result: 'FAIL', detail: { reason: 'never ran' } }],
      }),
    ).toBe('release script digest mismatch');
  });

  it('bounds a per-file reason and never renders a non-string one', () => {
    const long = summarizeSensorDetail(
      { files: [{ file: 'src/a.ts', result: 'FAIL', detail: { reason: 'e'.repeat(2000) } }] },
      'FAIL',
    );
    expect(long).toHaveLength(500);
    expect(long).toMatch(/^src\/a\.ts: e+…$/);
    expect(
      summarizeSensorDetail(
        {
          files: [
            {
              file: 'src/a.ts',
              result: 'FAIL',
              detail: { reason: { errors: 2 } as unknown as string },
            },
          ],
        },
        'FAIL',
      ),
    ).toBeNull();
  });

  it('returns null when nothing is worth showing', () => {
    expect(summarizeSensorDetail({ files: [{ file: 'src/a.ts', result: 'BLOCKED' }] })).toBeNull();
  });
});

describe('SensorChips', () => {
  it("puts a script sensor's reason on the chip the reader hovers", () => {
    render(
      <SensorChips
        runs={[
          run({
            detail: {
              files: [
                { file: 'src/slow.ts', result: 'INCONCLUSIVE', detail: { reason: 'timed out' } },
                { file: 'src/app.ts', result: 'FAIL', detail: { reason: '2 problems' } },
              ],
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText('linter').closest('[title]')).toHaveAttribute(
      'title',
      'linter: FAIL (blocking) — blocking — src/app.ts: 2 problems',
    );
  });
});
