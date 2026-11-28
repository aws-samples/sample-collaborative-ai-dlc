// Guards for the theme in src/index.css that the jsdom component tests cannot
// see: cascade-layer placement and colour contrast of the design tokens in both
// themes.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(import.meta.dirname, '../index.css'), 'utf8');
const root = postcss.parse(css);

const layerOf = (rule: Rule) => {
  for (let node = rule.parent; node && node.type !== 'root'; node = node.parent) {
    if (node.type === 'atrule' && (node as AtRule).name === 'layer') return (node as AtRule).params;
  }
  return null;
};

describe('index.css cascade layers', () => {
  it('keeps the global border colour in the base layer so border utilities apply', () => {
    const universal: Rule[] = [];
    root.walkRules('*', (rule) => {
      if (rule.some((decl) => decl.type === 'decl' && decl.prop.startsWith('border'))) {
        universal.push(rule);
      }
    });
    expect(universal).not.toHaveLength(0);
    for (const rule of universal) expect(layerOf(rule)).toBe('base');
  });

  it('keeps a focus outline in forced-colours mode, where ring box-shadows are dropped', () => {
    const focusRules: Rule[] = [];
    root.walkAtRules('media', (media) => {
      if (!media.params.includes('forced-colors: active')) return;
      media.walkRules((rule) => {
        if (rule.selectors.some((selector) => selector.startsWith(':focus-visible'))) {
          focusRules.push(rule);
        }
      });
    });
    expect(focusRules).toHaveLength(1);
    const [rule] = focusRules;
    // Unlayered, so it wins over the `outline-none` utilities.
    expect(layerOf(rule)).toBeNull();
    expect(rule.selectors).toContain('[data-collaborative-editor]:focus-within');
    const outline = rule.nodes.find((decl) => decl.type === 'decl' && decl.prop === 'outline');
    expect(outline && 'value' in outline ? outline.value : '').toMatch(/solid Highlight/);
  });
});

// ─── Theme blocks ──────────────────────────────────────────────────────────

type Vars = Record<string, string>;

const declarationsOf = (selector: string): Vars => {
  const vars: Vars = {};
  root.each((node) => {
    if (node.type !== 'rule' || node.selector !== selector) return;
    node.walkDecls((decl) => {
      vars[decl.prop] = decl.value;
    });
  });
  return vars;
};

describe('index.css colour scheme', () => {
  it('tells the browser which scheme each theme uses for native controls and selection', () => {
    expect(declarationsOf(':root')['color-scheme']).toBe('light');
    expect(declarationsOf('.dark')['color-scheme']).toBe('dark');
  });
});

// ─── Contrast (WCAG 2.x) ───────────────────────────────────────────────────

type Rgb = readonly [number, number, number];

const light = declarationsOf(':root');
const dark = { ...light, ...declarationsOf('.dark') };
const themes = { light, dark };

const toSrgb = (linear: number) =>
  linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** `oklch(L C H)` → sRGB in [0, 1] (CSS Color 4 matrices, clipped). */
const oklch = (value: string): Rgb => {
  const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!match) throw new Error(`not an opaque oklch() colour: ${value}`);
  const [L, C, H] = match.slice(1).map(Number);
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((c) => clamp(toSrgb(c))) as unknown as Rgb;
};

const token = (vars: Record<string, string>, name: string): Rgb => {
  const value = vars[name];
  if (!value) throw new Error(`index.css: ${name} is not defined`);
  return oklch(value);
};

/** `colour/alpha` painted over an opaque backdrop. */
const over = (colour: Rgb, alpha: number, backdrop: Rgb): Rgb =>
  colour.map((c, i) => c * alpha + backdrop[i] * (1 - alpha)) as unknown as Rgb;

const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const AA_TEXT = 4.5;

describe.each(Object.entries(themes))('%s theme contrast', (_name, vars) => {
  const background = token(vars, '--background');
  const card = token(vars, '--card');
  const destructive = token(vars, '--destructive');

  it.each([
    ['text-destructive on the page', background],
    ['text-destructive on a card', card],
    ['text-destructive on bg-destructive/5 over a card', over(destructive, 0.05, card)],
    ['text-destructive on bg-destructive/10 over the page', over(destructive, 0.1, background)],
    ['text-destructive on bg-destructive/10 over a card', over(destructive, 0.1, card)],
  ])('%s reads at AA', (_pair, surface) => {
    expect(contrast(destructive, surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps text readable on the collaborative editor selection', () => {
    const selection = token(vars, '--selection');
    expect(contrast(token(vars, '--foreground'), selection)).toBeGreaterThanOrEqual(AA_TEXT);
    // The highlight itself must stay visible against the surfaces editors sit on.
    expect(contrast(selection, background)).toBeGreaterThanOrEqual(1.3);
    expect(contrast(selection, card)).toBeGreaterThanOrEqual(1.3);
  });

  it('marks the chosen answer of an agent question with 3:1 non-text contrast', () => {
    const primary = token(vars, '--primary');
    const NON_TEXT = 3;
    // Selected option border, on the card and on its own bg-primary/10 tint.
    expect(contrast(primary, card)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(primary, over(primary, 0.1, card))).toBeGreaterThanOrEqual(NON_TEXT);
    // Radio dot and check mark on the filled indicator.
    expect(contrast(token(vars, '--primary-foreground'), primary)).toBeGreaterThanOrEqual(NON_TEXT);
    // Boundary of an unselected indicator.
    expect(contrast(token(vars, '--muted-foreground'), card)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  it.each([
    ['bg-destructive', 1],
    ['bg-destructive/90', 0.9],
    ['bg-destructive/80', 0.8],
  ])('text-destructive-foreground on %s reads at AA', (_fill, alpha) => {
    const fill = over(destructive, alpha, background);
    expect(contrast(token(vars, '--destructive-foreground'), fill)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
