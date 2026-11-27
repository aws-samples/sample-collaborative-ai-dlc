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
});
