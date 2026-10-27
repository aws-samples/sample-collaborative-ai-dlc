// Compose prompt budget — the required grounding is budgeted, not cut.
//
// A compose prompt carries two large optional bodies (the composer persona, and
// a report excerpt of up to MAX_REPORT_EXCERPT) alongside the text the platform
// needs the model to act on: the engine-command annex, the execution-environment
// note, the mode task, the intent, the deterministic grounding (every stock
// scope's compiled run shape AND the complete stage catalog) and the output
// contract that demands a grid covering that catalog.
//
// The budget must therefore be spent on the required text first. These are the
// regressions for that: real stock grounding of 2.8.2, 2.9.0 and 2.11.0 plus the
// maximum accepted report excerpt, asserting every catalog row arrives complete
// and the whole prompt stays within CONTEXT_LIMIT.

import { describe, it, expect } from 'vitest';
import {
  buildComposePrompt,
  COMPOSE_CONTEXT_LIMIT,
  COMPOSER_PERSONA_TRUNCATED,
  MAX_REPORT_EXCERPT,
  PLATFORM_ENVIRONMENT,
  REPORT_EXCERPT_TRUNCATED,
} from '../commands/compose-plan-start.js';
import { proposalContract } from '../../shared/compose-match.js';
import { catalogRows, stockGrounding } from './helpers/stock-grounding.js';

// The 2.8.2+ composer persona invokes the upstream engine and addresses the
// local harness, which is what pulls the dialect annex into the prompt, and it
// is ~46-48 KB of methodology prose on its own.
const STOCK_PERSONA = [
  'You are the AI-DLC composer agent.',
  'Detect the project with `bun {{HARNESS_DIR}}/tools/aidlc-utility.ts detect --json`.',
  '{{INVOKE}} engine log answer --question-id <id>',
  '{{INVOKE}} engine graph validate-grid --proposal <path>',
  'methodology prose. '.repeat(2400),
].join('\n');

const RELEASES = ['v2.8.2', 'v2.9.0', 'v2.11.0'];

describe.each(RELEASES)('compose prompt budget — %s stock grounding', (profileId) => {
  const { grounding, settingsAware, stages } = stockGrounding(profileId);
  const rows = catalogRows(grounding);

  const prompt = buildComposePrompt({
    mode: 'report',
    persona: STOCK_PERSONA,
    knowledge: 'Consult {{HARNESS_DIR}}/tools/data/stage-graph.json.',
    grounding,
    intentPrompt: 'Fix what the attached analysis report surfaces and ship it.',
    reportExcerpt: 'R'.repeat(MAX_REPORT_EXCERPT),
    settingsAware,
  });

  it('carries every stage catalog row complete', () => {
    expect(rows).toHaveLength(stages.length);
    expect(rows).toHaveLength(33);
    for (const row of rows) expect(prompt).toContain(`${row}\n`);
  });

  it('carries the whole grounding, the mode task, the intent and the output contract', () => {
    expect(prompt).toContain(grounding);
    expect(prompt).toContain('Task: an external analysis report is attached.');
    expect(prompt).toContain('Intent:\nFix what the attached analysis report surfaces');
    expect(prompt).toContain('Execution environment (overrides the procedure above)');
    expect(prompt.endsWith(`\n\n${proposalContract({ settingsAware })}`)).toBe(true);
  });

  it('stays within the context limit by bounding the lower-priority bodies', () => {
    expect(prompt.length).toBeLessThanOrEqual(COMPOSE_CONTEXT_LIMIT);
    expect(prompt).toContain(COMPOSER_PERSONA_TRUNCATED);
    expect(prompt).toContain(REPORT_EXCERPT_TRUNCATED);
    expect(prompt).toContain('Report excerpt:\nRRR');
  });
});

// The space left for the bounded sections can be smaller than their markers.
// A cut section must then give way entirely rather than overflow its share,
// or the prompt would fall to the last resort and lose the end of a grounding
// that fits on its own.
describe('compose prompt budget — no room left for the bounded sections', () => {
  const build = (grounding, persona, reportExcerpt) =>
    buildComposePrompt({ mode: 'report', persona, grounding, intentPrompt: 'I', reportExcerpt });

  it.each([0, 40, 100, 147])('keeps the grounding whole with %i characters to spare', (room) => {
    const probe = 'G'.repeat(1000);
    const fixed = build(probe, 'A', 'B').length - 'A'.length - 'Report excerpt:\nB'.length;
    const grounding = 'G'.repeat(1000 + COMPOSE_CONTEXT_LIMIT - fixed - room);
    const prompt = build(grounding, 'P'.repeat(40000), 'R'.repeat(MAX_REPORT_EXCERPT));

    expect(prompt).toContain(grounding);
    expect(prompt.length).toBeLessThanOrEqual(COMPOSE_CONTEXT_LIMIT);
  });
});

// An unpinned or 2.3.3 intent grounds on a release that authors no per-intent
// setting and whose composer names no engine command, and its whole prompt fits.
// That prompt is joined in section order and nothing is bounded — byte for byte
// what it was before the budget existed.
describe('compose prompt budget — a prompt that fits is byte-identical', () => {
  it('joins the sections in order with no marker and no bounding', () => {
    const { grounding, settingsAware } = stockGrounding('v2.8.2');
    const prompt = buildComposePrompt({
      mode: 'front',
      persona: 'You are the AI-DLC composer agent.',
      knowledge: 'KNOWLEDGE',
      grounding,
      intentPrompt: 'Build the thing',
      instructions: 'Keep it minimal.',
      reportExcerpt: 'REPORT',
      settingsAware,
    });

    expect(settingsAware).toBe(false);
    expect(prompt).toBe(
      [
        'You are the AI-DLC composer agent.',
        'KNOWLEDGE',
        PLATFORM_ENVIRONMENT,
        'Task: propose the workflow projection that fits this intent.\nPrefer a stock scope (mode "matched") when one genuinely fits; compose a custom grid only when no stock shape does.',
        'Intent:\nBuild the thing',
        'Requester instructions:\nKeep it minimal.',
        'Report excerpt:\nREPORT',
        grounding,
        proposalContract({ settingsAware: false }),
      ].join('\n\n'),
    );
    expect(prompt.length).toBeLessThanOrEqual(COMPOSE_CONTEXT_LIMIT);
    expect(prompt).not.toContain(COMPOSER_PERSONA_TRUNCATED);
    expect(prompt).not.toContain(REPORT_EXCERPT_TRUNCATED);
  });
});
