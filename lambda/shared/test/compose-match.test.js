import { describe, it, expect } from 'vitest';
import {
  authoredScopeSettings,
  keywordHit,
  matchScopeByKeywords,
  buildGroundingPack,
  parseComposeProposal,
  proposalContract,
  PROPOSAL_CONTRACT,
} from '../compose-match.js';
import { capabilityFor } from '../aidlc-capabilities.js';

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

describe('buildGroundingPack — the settings a release has', () => {
  it('renders the settings each scope authors when the release has them', () => {
    const pack = buildGroundingPack({
      scopes: [{ id: 'classic' }, { id: 'enterprise' }],
      scopeSettings: {
        classic: { guard_policy: 'off', collaborators: 'off' },
        enterprise: { guard_policy: 'strict' },
      },
      settingsScopeId: 'classic',
    });
    expect(pack).toContain('Settings: guard_policy=off, collaborators=off');
    expect(pack).toContain('Settings: guard_policy=strict');
  });

  // The per-scope settings lines belong to the releases that HAVE per-intent
  // settings. Rendering them whenever a scope authors any registry-known field
  // would add lines to the compose prompt of every older pinned release, so the
  // caller names the selected settings scope only for a release that has them.
  it('renders no authored settings lines for a release without per-intent settings', () => {
    const pack = buildGroundingPack({
      scopes: [{ id: 'classic' }],
      scopeSettings: { classic: { change_control: 'relaxed', review_cap: 'advisory' } },
    });
    expect(pack).not.toContain('Settings:');
  });

  it('renders the effective settings with their source and forbids reading them from a file', () => {
    const pack = buildGroundingPack({
      scopes: [{ id: 'classic' }],
      settingsScopeId: 'classic',
      effectiveSettings: [
        { name: 'guard_policy', value: 'strict', source: 'changed for this intent' },
        { name: 'plan_approval', value: 'off', source: 'scope default' },
      ],
    });
    expect(pack).toContain('## AI-DLC settings in force for this intent');
    expect(pack).toContain('Resolved for the selected scope "classic".');
    expect(pack).toContain('- guard_policy: strict (changed for this intent)');
    expect(pack).toContain('- plan_approval: off (scope default)');
    expect(pack).toMatch(/do not look for a settings, environment or shell file/);
    expect(pack).toMatch(/you never apply one yourself/);
  });

  // No name in the grounding either: the effective rows describe state, and
  // who changed a setting is on the intent timeline.
  it('names nobody in the effective settings section', () => {
    const pack = buildGroundingPack({
      scopes: [{ id: 'classic' }],
      settingsScopeId: 'classic',
      effectiveSettings: [
        { name: 'guard_policy', value: 'strict', source: 'changed for this intent' },
      ],
    });
    expect(pack).not.toMatch(/chosen by/i);
  });

  it('renders no settings section at all for a release that authors none', () => {
    const pack = buildGroundingPack({ scopes: [{ id: 'bugfix' }] });
    expect(pack).not.toContain('Settings:');
    expect(pack).not.toContain('AI-DLC settings in force');
  });
});

describe('authoredScopeSettings', () => {
  // Keyed by the field name the SCOPE FILE uses, which is the name the
  // composer's own contract speaks — not the camelCase the mapper writes.
  it('reads the registry-known settings off a scope block under their authored names', () => {
    expect(
      authoredScopeSettings({ guardPolicy: 'off', planApproval: 'on', collaborators: 'off' }),
    ).toMatchObject({ guard_policy: 'off', plan_approval: 'on', collaborators: 'off' });
    expect(authoredScopeSettings(null)).toEqual({});
  });
});

describe('parseComposeProposal — the settings proposal', () => {
  const withSettings = (extra) =>
    parseComposeProposal(JSON.stringify({ mode: 'matched', scope: 'bugfix', ...extra }));

  it('keeps the guard policy, every scope setting, the base scope and the depth', () => {
    const { proposal, error } = withSettings({
      guardPolicy: 'strict',
      scopeSettings: {
        sensors: 'on',
        learnings: 'off',
        summary_confirmation: 'off',
        plan_approval: 'on',
        collaborators: 'off',
        review_cap: 'advisory',
      },
      baseScope: 'classic',
      creationDepth: 'standard',
    });
    expect(error).toBeUndefined();
    expect(proposal.guardPolicy).toBe('strict');
    expect(proposal.scopeSettings).toEqual({
      sensors: 'on',
      learnings: 'off',
      summary_confirmation: 'off',
      plan_approval: 'on',
      collaborators: 'off',
      review_cap: 'advisory',
    });
    expect(proposal.baseScope).toBe('classic');
    expect(proposal.creationDepth).toBe('standard');
  });

  it('reads its legal values from the capability registry rather than its own list', () => {
    expect(capabilityFor('SCOPE:guard_policy').values).toBeTruthy();
    for (const value of Object.keys(capabilityFor('SCOPE:guard_policy').values)) {
      expect(withSettings({ guardPolicy: value }).proposal.guardPolicy).toBe(value);
    }
    for (const value of Object.keys(capabilityFor('SCOPE:review_cap').values)) {
      expect(withSettings({ scopeSettings: { review_cap: value } }).proposal.scopeSettings).toEqual(
        { review_cap: value },
      );
    }
  });

  it('refuses an out-of-enum value by name, with no partial application', () => {
    const guard = withSettings({ guardPolicy: 'paranoid' });
    expect(guard.proposal).toBeUndefined();
    expect(guard.error).toMatch(/guardPolicy must be one of strict \| relaxed \| off/);

    const setting = withSettings({ scopeSettings: { collaborators: 'maybe' } });
    expect(setting.proposal).toBeUndefined();
    expect(setting.error).toMatch(/scopeSettings\["collaborators"\] must be one of on \| off/);
  });

  it('refuses a setting name the methodology does not have', () => {
    const { error, proposal } = withSettings({ scopeSettings: { machine_kill_switch: 'on' } });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/scopeSettings\["machine_kill_switch"\] is not a setting/);
  });

  // Upstream's in-flight settings change is refused BY NAME rather than parsed
  // as a no-op: a composer whose change was silently dropped would believe it
  // had been taken.
  it('refuses an in-flight settings change by name instead of dropping it', () => {
    const { error, proposal } = withSettings({ settingsChanges: { sensors: 'off' } });
    expect(proposal).toBeUndefined();
    expect(error).toMatch(/compose_settings_change_unsupported/);
    expect(error).toMatch(/a human changes them before the run starts/);
  });

  it('refuses a blank base scope or an over-long depth rather than keeping the label', () => {
    expect(withSettings({ baseScope: '   ' }).error).toMatch(/baseScope must be/);
    expect(withSettings({ creationDepth: 'x'.repeat(65) }).error).toMatch(/creationDepth must be/);
  });

  it('carries none of the members when the composer sends none', () => {
    const { proposal } = parseComposeProposal('{"mode":"matched","scope":"bugfix"}');
    expect(Object.keys(proposal).toSorted()).toEqual([
      'confidence',
      'grid',
      'mode',
      'rationale',
      'scope',
    ]);
  });
});

// The compatibility property the whole gating exists for: a release that
// authors no per-intent setting is asked for none, so its output contract — and
// therefore its whole compose prompt — is byte-identical to what it was.
describe('proposalContract', () => {
  it('is byte-identical to the pre-settings contract for a release without them', () => {
    expect(proposalContract({ settingsAware: false })).toBe(PROPOSAL_CONTRACT);
    expect(PROPOSAL_CONTRACT).not.toContain('guardPolicy');
    expect(PROPOSAL_CONTRACT).not.toContain('scopeSettings');
    expect(PROPOSAL_CONTRACT).not.toContain('baseScope');
    expect(PROPOSAL_CONTRACT).not.toContain('settingsChanges');
  });

  it('asks for the settings, as a proposal a person accepts, when the release has them', () => {
    const aware = proposalContract({ settingsAware: true });
    expect(aware).toContain('"guardPolicy"');
    expect(aware).toContain('"scopeSettings"');
    expect(aware).toContain('"baseScope"');
    expect(aware).toContain('"creationDepth"');
    expect(aware).toContain('Do NOT return "settingsChanges"');
    expect(aware).toMatch(/accepts them on the compose page/);
    // Both forms keep the same closing rule, so the parser's failure contract
    // is stated once for every release.
    expect(aware.endsWith(PROPOSAL_CONTRACT.split('\n').at(-1))).toBe(true);
  });

  // The parser is deliberately NOT gated: a model that volunteers the members
  // on an older pin is parsed rather than refused. Nothing offers them to a
  // member, because the plan authors nothing to offer.
  it('still parses the members when an ungated release volunteers them', () => {
    const { proposal, error } = parseComposeProposal(
      '{"mode":"matched","scope":"bugfix","guardPolicy":"strict"}',
    );
    expect(error).toBeUndefined();
    expect(proposal.guardPolicy).toBe('strict');
  });
});
