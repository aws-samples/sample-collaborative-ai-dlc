import { describe, it, expect } from 'vitest';
import {
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  PROPOSAL_CONTRACT,
} from '../compose-match.js';

describe('keywordHit', () => {
  it('matches on word boundaries only', () => {
    expect(keywordHit('fix the auth flow', 'auth')).toBe(true);
    expect(keywordHit('the author wrote it', 'auth')).toBe(false);
    expect(keywordHit('AUTH broken', 'auth')).toBe(true);
    expect(keywordHit('hotfix: crash', 'hotfix')).toBe(true);
  });

  it('tolerates empty/blank keywords and regex metacharacters', () => {
    expect(keywordHit('anything', '')).toBe(false);
    expect(keywordHit('c++ build', 'c++')).toBe(true);
  });
});

describe('matchScopeByKeywords', () => {
  const scopes = [
    { id: 'bugfix', keywords: ['bugfix', 'hotfix'] },
    { id: 'feature', keywords: ['feature'] },
    { id: 'refactor', keywords: [] },
  ];

  it('returns the single cleanly matching scope', () => {
    expect(matchScopeByKeywords({ text: 'ship a hotfix for login', scopes })).toEqual({
      scopeId: 'bugfix',
      matched: ['hotfix'],
    });
  });

  it('returns null when nothing matches', () => {
    expect(matchScopeByKeywords({ text: 'improve docs', scopes })).toBeNull();
  });

  it('returns null on an ambiguous multi-scope hit (the composer decides)', () => {
    expect(matchScopeByKeywords({ text: 'a feature and a hotfix', scopes })).toBeNull();
  });
});

describe('buildGroundingPack', () => {
  it('renders scope shapes, keywords, grids and the stage catalog', () => {
    const pack = buildGroundingPack({
      scopes: [{ id: 'bugfix', description: 'Fix and ship.', keywords: ['hotfix'] }],
      summaries: {
        bugfix: {
          executedStages: 5,
          totalStages: 12,
          approvalGates: 3,
          perUnitStages: 0,
          skippedStages: 0,
          outOfScopeStages: 7,
        },
      },
      grids: { bugfix: { init: 'EXECUTE', design: 'SKIP' } },
      stages: [
        {
          id: 'design',
          phase: 'construction',
          execution: 'CONDITIONAL',
          produces: ['model'],
          optionalProduces: ['frontend-components'],
          consumes: [{ artifact: 'spec', required: true }],
        },
      ],
    });
    expect(pack).toContain('bugfix: runs 5 of 12 stages, 3 approval gates');
    expect(pack).toContain('Keywords: hotfix');
    expect(pack).toContain('EXECUTE: init');
    expect(pack).toContain(
      'design | construction | CONDITIONAL | model, frontend-components? | spec',
    );
  });
});

describe('parseComposeProposal', () => {
  it('parses a fenced matched proposal', () => {
    const { proposal, error } = parseComposeProposal(
      'Here you go:\n```json\n{"mode":"matched","scope":"bugfix","rationale":["r1"],"confidence":0.9}\n```',
    );
    expect(error).toBeUndefined();
    expect(proposal).toEqual({
      mode: 'matched',
      scope: 'bugfix',
      grid: null,
      rationale: ['r1'],
      confidence: 0.9,
    });
  });

  it('parses an unfenced custom proposal and normalizes grid values', () => {
    const { proposal } = parseComposeProposal(
      '{"mode":"custom","scope":"my-fix","grid":{"a":"execute","b":"Skip"},"rationale":[]}',
    );
    expect(proposal.grid).toEqual({ a: 'EXECUTE', b: 'SKIP' });
  });

  it('surfaces a declared composer failure as a structured error', () => {
    const { error } = parseComposeProposal('{"mode":"failed","reason":"cannot see the workflow"}');
    expect(error).toMatch(/composer declared failure: cannot see the workflow/);
  });

  it('rejects garbage, bad modes, missing scopes, bad grid values and empty grids', () => {
    expect(parseComposeProposal('no json here').error).toMatch(/no JSON object/);
    expect(parseComposeProposal('{"mode":"wild","scope":"x"}').error).toMatch(/mode must be/);
    expect(parseComposeProposal('{"mode":"matched"}').error).toMatch(/name a scope/);
    expect(parseComposeProposal('{"mode":"custom","scope":"x"}').error).toMatch(/carry a grid/);
    expect(
      parseComposeProposal('{"mode":"custom","scope":"x","grid":{"a":"MAYBE"}}').error,
    ).toMatch(/EXECUTE or SKIP/);
    expect(parseComposeProposal('{"mode":"custom","scope":"x","grid":{}}').error).toMatch(
      /grid is empty/,
    );
  });

  it('the contract text documents the exact failure escape hatch it parses', () => {
    expect(PROPOSAL_CONTRACT).toContain('"mode":"failed"');
  });
});
