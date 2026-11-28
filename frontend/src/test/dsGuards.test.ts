// Design-system guard ratchet.
//
// Counts known anti-patterns per source file and compares them with
// dsGuards.baseline.json. A file may never exceed its baseline count, and a
// file absent from the baseline must have a zero count. Drops below baseline
// are reported (console.info) so the integrator can tighten the ratchet.
//
// Regenerate the baseline (integrator only):
//   UPDATE_DS_BASELINE=1 npx vitest run src/test/dsGuards.test.ts
//
// Scope: src/**/*.{ts,tsx}, excluding *.test.*, src/test/** and
// components/ui/** (design-system primitives may legitimately use these
// patterns). Counting is a plain regex scan of the source text, so a pattern
// inside a comment or string also counts; that is accepted for a ratchet.
import fs from 'node:fs';
import path from 'node:path';

type Baseline = Record<string, Record<string, number>>;

interface GuardPattern {
  id: string;
  regex: RegExp;
  allow?: string[];
}

const PATTERNS: GuardPattern[] = [
  { id: 'details-element', regex: /<details\b/g },
  { id: 'window-confirm', regex: /window\.confirm\(/g },
  { id: 'font-size-below-11px', regex: /text-\[(?:8|9|10)px\]/g },
  { id: 'amber-text-workaround', regex: /text-amber-(?:500|600)\b/g },
  { id: 'indigo-palette', regex: /\bindigo-\d/g },
  // Heuristic: an uppercase backend status literal written directly as JSX
  // text (`>FAILED<`). Status labels belong to the shared status model.
  {
    id: 'raw-status-jsx-text',
    regex: />(?:SUCCEEDED|CANCELLED|FAILED|RUNNING|WAITING)</g,
    allow: ['lib/statusModel.ts'],
  },
];

const SRC_ROOT = path.resolve(import.meta.dirname, '..');
const BASELINE_PATH = path.join(import.meta.dirname, 'dsGuards.baseline.json');

function isScannedFile(relPath: string): boolean {
  if (!/\.(?:ts|tsx)$/.test(relPath)) return false;
  if (/\.test\.[^/]+$/.test(relPath)) return false;
  if (relPath.startsWith('test/')) return false;
  if (relPath.startsWith('components/ui/')) return false;
  return true;
}

function countPattern(source: string, regex: RegExp): number {
  return source.match(new RegExp(regex.source, regex.flags))?.length ?? 0;
}

function countFile(relPath: string, source: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!isScannedFile(relPath)) return counts;
  for (const pattern of PATTERNS) {
    if (pattern.allow?.includes(relPath)) continue;
    const n = countPattern(source, pattern.regex);
    if (n > 0) counts[pattern.id] = n;
  }
  return counts;
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

function scanTree(): Baseline {
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const result: Baseline = Object.fromEntries(PATTERNS.map((p) => [p.id, {}]));
  for (const file of files.sort()) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (!isScannedFile(rel)) continue;
    const counts = countFile(rel, fs.readFileSync(file, 'utf8'));
    for (const [id, n] of Object.entries(counts)) result[id][rel] = n;
  }
  return result;
}

function compare(
  current: Baseline,
  baseline: Baseline,
): { regressions: string[]; improvements: string[] } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const { id } of PATTERNS) {
    const now = current[id] ?? {};
    const base = baseline[id] ?? {};
    for (const file of new Set([...Object.keys(now), ...Object.keys(base)])) {
      const n = now[file] ?? 0;
      const b = base[file] ?? 0;
      if (n > b) regressions.push(`${id}: ${file} has ${n} (baseline ${b})`);
      else if (n < b) improvements.push(`${id}: ${file} dropped to ${n} (baseline ${b})`);
    }
  }
  return { regressions, improvements };
}

describe('design-system guard helpers', () => {
  it('counts each pattern on inline samples', () => {
    const sample = [
      '<details><summary>x</summary></details>',
      'window.confirm("x")',
      '<span className="text-[9px] text-[10px] text-[11px]" />',
      'text-amber-500 text-amber-600 text-amber-700',
      'bg-indigo-50 text-indigo-700',
      '<span>FAILED</span><span>Failed</span>',
    ].join('\n');
    expect(countFile('components/Sample.tsx', sample)).toEqual({
      'details-element': 1,
      'window-confirm': 1,
      'font-size-below-11px': 2,
      'amber-text-workaround': 2,
      'indigo-palette': 2,
      'raw-status-jsx-text': 1,
    });
  });

  it('excludes primitives, tests and the status model', () => {
    expect(countFile('components/ui/Disclosure.tsx', '<details>')).toEqual({});
    expect(countFile('pages/Sample.test.tsx', '<details>')).toEqual({});
    expect(countFile('test/setup.ts', '<details>')).toEqual({});
    expect(countFile('lib/statusModel.ts', '<b>FAILED</b>')).toEqual({});
  });

  it('flags increases and new files, reports drops', () => {
    const baseline = { 'details-element': { 'a.tsx': 2 } };
    expect(compare({ 'details-element': { 'a.tsx': 3 } }, baseline).regressions).toHaveLength(1);
    expect(
      compare({ 'details-element': { 'b.tsx': 1, 'a.tsx': 2 } }, baseline).regressions,
    ).toEqual(['details-element: b.tsx has 1 (baseline 0)']);
    expect(compare({ 'details-element': { 'a.tsx': 1 } }, baseline)).toEqual({
      regressions: [],
      improvements: ['details-element: a.tsx dropped to 1 (baseline 2)'],
    });
  });
});

describe('design-system guard ratchet', () => {
  it('does not exceed dsGuards.baseline.json', () => {
    const current = scanTree();
    if (process.env.UPDATE_DS_BASELINE === '1') {
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
      console.info(`dsGuards: baseline rewritten at ${BASELINE_PATH}`);
      return;
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
    const { regressions, improvements } = compare(current, baseline);
    if (improvements.length > 0) {
      console.info(
        `dsGuards: counts below baseline (run UPDATE_DS_BASELINE=1 to ratchet):\n  ${improvements.join('\n  ')}`,
      );
    }
    expect(regressions, 'Design-system guard regressions').toEqual([]);
  });
});
