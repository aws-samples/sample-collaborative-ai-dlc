// Design-token contrast guard for src/index.css.
//
// Parses the `:root` (light) and `.dark` blocks, resolves `var()` chains,
// converts OKLCH / hex / rgb() to sRGB with CSS Color 4 gamut mapping, and
// asserts the WCAG 2.x contrast rules the design system promises:
//   - every `--agent-*-fg` text token reads at >= 4.5:1 on `--background`,
//     on `--card`, and on a 15 % tint of its own base colour over `--card`
//     (the `bg-agent-x/15 text-agent-x-fg` pill pattern), in both themes;
//   - `--warning` / `--warning-fg` are a distinct family from waiting;
//   - `--muted-foreground-on-tint` reads at >= 4.5:1 on `primary/10` over card;
//   - phase tokens never equal a status token (phase and status must not be
//     confusable) and differ from one another (the Okabe-Ito palette);
//   - the type scale has no token below 11 px.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(import.meta.dirname, '../index.css'), 'utf8');

type Rgb = readonly [number, number, number];
type Vars = Record<string, string>;

const AA = 4.5;
const STATUSES = ['idle', 'running', 'waiting', 'success', 'error', 'warning'] as const;
const PHASES = [
  'initialization',
  'ideation',
  'inception',
  'construction',
  'operation',
  'review',
] as const;

// ─── CSS parsing ────────────────────────────────────────────────────────────

function block(selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const match = css.match(re);
  if (!match) throw new Error(`index.css: no top-level block for ${selector}`);
  return match[2];
}

function declarations(body: string): Vars {
  const out: Vars = {};
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const themeInline = declarations(block('@theme inline'));
const light = declarations(block(':root'));
const dark = { ...light, ...declarations(block('.dark')) };

function resolve(value: string, vars: Vars, depth = 0): string {
  if (depth > 10) throw new Error(`var() chain too deep: ${value}`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const next = vars[name] ?? themeInline[name];
    if (next === undefined) throw new Error(`unresolved ${name}`);
    return resolve(next, vars, depth + 1);
  });
}

// ─── Colour math (CSS Color 4) ──────────────────────────────────────────────

function oklabToLinearSrgb(L: number, a: number, b: number): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function linearSrgbToOklab([r, g, b]: Rgb): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklchToOklab(L: number, C: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

const inGamut = (rgb: Rgb) => rgb.every((c) => c >= -1e-6 && c <= 1 + 1e-6);
const clip = (rgb: Rgb): Rgb => rgb.map((c) => Math.min(1, Math.max(0, c))) as unknown as Rgb;

function deltaEok(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = linearSrgbToOklab(a);
  const [l2, a2, b2] = linearSrgbToOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// CSS Color 4 §13.2 gamut mapping: reduce chroma in OKLCH until the clipped
// colour is within the just-noticeable difference of the candidate.
function oklchToLinearSrgb(L: number, C: number, h: number): Rgb {
  if (L >= 1) return [1, 1, 1];
  if (L <= 0) return [0, 0, 0];
  const direct = oklabToLinearSrgb(...oklchToOklab(L, C, h));
  if (inGamut(direct)) return direct;
  let lo = 0;
  let hi = C;
  let best = clip(direct);
  while (hi - lo > 1e-4) {
    const mid = (lo + hi) / 2;
    const candidate = oklabToLinearSrgb(...oklchToOklab(L, mid, h));
    if (inGamut(candidate)) {
      lo = mid;
      best = candidate;
    } else {
      const clipped = clip(candidate);
      if (deltaEok(candidate, clipped) < 0.02) return clipped;
      hi = mid;
    }
  }
  return best;
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function parseColor(value: string, vars: Vars): Rgb {
  const v = resolve(value, vars).trim();
  let m = v.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (m) {
    const L = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    return oklchToLinearSrgb(L, parseFloat(m[2]), parseFloat(m[3]));
  }
  m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255].map((c) => srgbToLinear(c / 255)) as unknown as Rgb;
  }
  m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) {
    return [m[1], m[2], m[3]].map((c) => srgbToLinear(Number(c) / 255)) as unknown as Rgb;
  }
  throw new Error(`unsupported colour syntax: ${value} -> ${v}`);
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function contrast(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

// Source-over compositing of `top` at `alpha` on an opaque `under`. Browsers
// blend `bg-x/15` in gamma-encoded sRGB, not in linear light, so the mix is
// done on sRGB components and converted back; measured axe ratios match this.
function tint(top: Rgb, alpha: number, under: Rgb): Rgb {
  return top.map((c, i) =>
    srgbToLinear(linearToSrgb(c) * alpha + linearToSrgb(under[i]) * (1 - alpha)),
  ) as unknown as Rgb;
}

const round = (n: number) => Math.round(n * 100) / 100;

// ─── Tests ──────────────────────────────────────────────────────────────────

const THEMES: Array<[string, Vars]> = [
  ['light', light],
  ['dark', dark],
];

describe('status foreground tokens (--agent-*-fg)', () => {
  for (const [name, vars] of THEMES) {
    describe(name, () => {
      for (const status of STATUSES) {
        it(`--agent-${status}-fg reads at >= ${AA}:1 on background, card and its own 15 % tint`, () => {
          const background = parseColor('var(--background)', vars);
          const card = parseColor('var(--card)', vars);
          const fg = parseColor(`var(--agent-${status}-fg)`, vars);
          const base = parseColor(`var(--agent-${status})`, vars);
          const pill = tint(base, 0.15, card);
          const ratios = {
            background: round(contrast(fg, background)),
            card: round(contrast(fg, card)),
            tint: round(contrast(fg, pill)),
          };
          expect(
            ratios.background,
            `on --background ${JSON.stringify(ratios)}`,
          ).toBeGreaterThanOrEqual(AA);
          expect(ratios.card, `on --card ${JSON.stringify(ratios)}`).toBeGreaterThanOrEqual(AA);
          expect(
            ratios.tint,
            `on bg-agent-${status}/15 ${JSON.stringify(ratios)}`,
          ).toBeGreaterThanOrEqual(AA);
        });
      }

      it('maps every fg token to a text utility in @theme inline', () => {
        for (const status of STATUSES) {
          expect(themeInline[`--color-agent-${status}-fg`]).toBe(`var(--agent-${status}-fg)`);
        }
      });
    });
  }
});

describe('warning family', () => {
  it('is mapped to utilities', () => {
    expect(themeInline['--color-warning']).toBe('var(--warning)');
    expect(themeInline['--color-warning-fg']).toBe('var(--warning-fg)');
  });

  for (const [name, vars] of THEMES) {
    it(`${name}: --warning differs from --agent-waiting and --warning-fg reads on card and tint`, () => {
      const warning = parseColor('var(--warning)', vars);
      const waiting = parseColor('var(--agent-waiting)', vars);
      expect(deltaEok(warning, waiting)).toBeGreaterThan(0.05);

      const card = parseColor('var(--card)', vars);
      const background = parseColor('var(--background)', vars);
      const fg = parseColor('var(--warning-fg)', vars);
      expect(round(contrast(fg, background))).toBeGreaterThanOrEqual(AA);
      expect(round(contrast(fg, card))).toBeGreaterThanOrEqual(AA);
      expect(round(contrast(fg, tint(warning, 0.15, card)))).toBeGreaterThanOrEqual(AA);
    });
  }
});

// Every surface `text-muted-foreground` is painted on in the app: plain
// surfaces (card, background, sidebar, the muted / secondary / accent fills
// behind TabsList, kbd and chips) and the translucent Alert / waiting tints
// that carry an AlertDescription or a muted sub-line. P1-1 of the a11y audit:
// in the light theme the token used to read at 4.2–4.47:1 on all of these.
const plain = (token: string) => (vars: Vars) => parseColor(`var(${token})`, vars);
const over = (token: string, alpha: number, under: string) => (vars: Vars) =>
  tint(parseColor(`var(${token})`, vars), alpha, parseColor(`var(${under})`, vars));

const MUTED_FOREGROUND_SURFACES: Array<[string, (vars: Vars) => Rgb]> = [
  ['--background', plain('--background')],
  ['--card', plain('--card')],
  ['--popover', plain('--popover')],
  ['--muted', plain('--muted')],
  ['--secondary', plain('--secondary')],
  ['--accent', plain('--accent')],
  ['--sidebar', plain('--sidebar')],
  ['--sidebar-accent', plain('--sidebar-accent')],
  ['muted/40 over card (Alert neutral)', over('--muted', 0.4, '--card')],
  ['muted/40 over background (Alert neutral)', over('--muted', 0.4, '--background')],
  ['primary/5 over card (Alert info)', over('--primary', 0.05, '--card')],
  ['primary/5 over background (Alert info)', over('--primary', 0.05, '--background')],
  ['agent-success/5 over card (Alert success)', over('--agent-success', 0.05, '--card')],
  [
    'agent-success/5 over background (Alert success)',
    over('--agent-success', 0.05, '--background'),
  ],
  ['warning/10 over card (Alert warning)', over('--warning', 0.1, '--card')],
  ['warning/10 over background (Alert warning)', over('--warning', 0.1, '--background')],
  ['destructive/5 over card (Alert danger)', over('--destructive', 0.05, '--card')],
  ['destructive/5 over background (Alert danger)', over('--destructive', 0.05, '--background')],
  ['agent-waiting/15 over card (waiting tint)', over('--agent-waiting', 0.15, '--card')],
  [
    'agent-waiting/15 over background (waiting tint)',
    over('--agent-waiting', 0.15, '--background'),
  ],
];

describe('--muted-foreground', () => {
  it('is mapped to a utility', () => {
    expect(themeInline['--color-muted-foreground']).toBe('var(--muted-foreground)');
  });

  for (const [name, vars] of THEMES) {
    describe(name, () => {
      for (const [surface, paint] of MUTED_FOREGROUND_SURFACES) {
        it(`reads at >= ${AA}:1 on ${surface}`, () => {
          const fg = parseColor('var(--muted-foreground)', vars);
          const ratio = round(contrast(fg, paint(vars)));
          expect(ratio, `--muted-foreground on ${surface}: ${ratio}`).toBeGreaterThanOrEqual(AA);
        });
      }

      it('stays lighter than the foreground so it still reads as secondary text', () => {
        const fg = parseColor('var(--foreground)', vars);
        const muted = parseColor('var(--muted-foreground)', vars);
        const card = parseColor('var(--card)', vars);
        expect(contrast(fg, card)).toBeGreaterThan(contrast(muted, card));
      });
    });
  }
});

describe('--muted-foreground-on-tint', () => {
  it('is mapped to a utility', () => {
    expect(themeInline['--color-muted-foreground-on-tint']).toBe('var(--muted-foreground-on-tint)');
  });

  for (const [name, vars] of THEMES) {
    it(`${name}: reads at >= ${AA}:1 on primary/10 over card and on card`, () => {
      const card = parseColor('var(--card)', vars);
      const primary = parseColor('var(--primary)', vars);
      const fg = parseColor('var(--muted-foreground-on-tint)', vars);
      expect(round(contrast(fg, tint(primary, 0.1, card)))).toBeGreaterThanOrEqual(AA);
      expect(round(contrast(fg, card))).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe('phase tokens', () => {
  for (const [name, vars] of THEMES) {
    describe(name, () => {
      const statusColors = () => [
        ...STATUSES.map((s) => parseColor(`var(--agent-${s})`, vars)),
        parseColor('var(--warning)', vars),
        parseColor('var(--destructive)', vars),
      ];

      for (const phase of PHASES) {
        it(`--phase-${phase} is distinct from every status colour and every other phase`, () => {
          const raw = resolve(`var(--phase-${phase})`, vars);
          expect(raw, `phase tokens must be literal oklch(): ${raw}`).toMatch(
            /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\)$/,
          );

          const fill = parseColor(raw, vars);
          for (const status of statusColors()) {
            expect(deltaEok(fill, status)).toBeGreaterThan(0.05);
          }
          for (const other of PHASES) {
            if (other === phase) continue;
            const otherFill = parseColor(`var(--phase-${other})`, vars);
            expect(deltaEok(fill, otherFill), `${phase} vs ${other}`).toBeGreaterThan(0.1);
          }
        });

        it(`--phase-${phase}-foreground reads at >= ${AA}:1 on its fill`, () => {
          const fill = parseColor(`var(--phase-${phase})`, vars);
          const fg = parseColor(`var(--phase-${phase}-foreground)`, vars);
          expect(round(contrast(fg, fill))).toBeGreaterThanOrEqual(AA);
        });
      }
    });
  }
});

describe('type scale', () => {
  it('defines text-2xs as 11 px / 16 px', () => {
    expect(themeInline['--text-2xs']).toBe('0.6875rem');
    expect(themeInline['--text-2xs--line-height']).toBe('1rem');
  });

  it('has no font-size token below 11 px', () => {
    for (const [name, value] of Object.entries(themeInline)) {
      if (!/^--text-[\w-]+$/.test(name) || name.includes('--line-height')) continue;
      const rem = value.match(/^([\d.]+)rem$/);
      const px = value.match(/^([\d.]+)px$/);
      const size = rem ? parseFloat(rem[1]) * 16 : px ? parseFloat(px[1]) : NaN;
      expect(size, `${name}: ${value}`).toBeGreaterThanOrEqual(11);
    }
  });
});

describe('motion', () => {
  it('registers tailwindcss-animate so animate-in/out utilities exist', () => {
    expect(css).toMatch(/@plugin\s+["']tailwindcss-animate["'];/);
  });

  it('has a global prefers-reduced-motion rule', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
