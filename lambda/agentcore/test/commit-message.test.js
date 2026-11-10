import { describe, it, expect, vi } from 'vitest';
import {
  consumeCommitDescription,
  createEngineCommitMessages,
  engineCommitMessage,
  normaliseChangeDescription,
  readCommitDescription,
  stageCommitMessages,
  trackerKey,
} from '../commit-message.js';

const jira = (resourceId, over = {}) => ({
  bindingId: 'b1',
  provider: 'jira-cloud',
  resourceType: 'issue',
  resourceId,
  ...over,
});

describe('trackerKey', () => {
  it.each([
    [jira('ABC-12'), 'ABC-12'],
    [jira('A1_B-7', { resourceType: undefined }), 'A1_B-7'],
    [jira('abc-12'), null],
    [jira('ABC-0'), null],
    [jira('ABC-12 rm -rf'), null],
    [jira('ABC-12', { resourceType: 'epic-link' }), null],
    [{ provider: 'github-issues', resourceType: 'issue', resourceId: '42' }, null],
    [null, null],
  ])('%j gives %s', (source, key) => {
    expect(trackerKey(source)).toBe(key);
  });
});

describe('engineCommitMessage', () => {
  const message = (options, intent = null) =>
    engineCommitMessage({ executionId: 'e1', intent, ...options });

  it('writes a Conventional Commits header with the Jira key and attribution trailers', () => {
    expect(
      message(
        { stageId: 'code-generation', unitSlug: 'billing' },
        { title: 'Stagger renovate runs', source: jira('ABC-12') },
      ),
    ).toBe(
      [
        'chore(aidlc): checkpoint code-generation stage for billing [ABC-12]',
        '',
        'Intent: Stagger renovate runs',
        '',
        'AIDLC-Stage: code-generation',
        'AIDLC-Unit: billing',
        'AIDLC-Execution: e1',
      ].join('\n'),
    );
  });

  it('leaves out the key and title when the intent has neither', () => {
    expect(message({ stageId: 'requirements-analysis' })).toBe(
      'chore(aidlc): checkpoint requirements-analysis stage\n\nAIDLC-Stage: requirements-analysis\nAIDLC-Execution: e1',
    );
  });

  it.each([
    [{ stageId: 'code-generation', label: 'lead draft' }, 'checkpoint code-generation lead draft'],
    [
      { stageId: 'code-generation', unitSlug: 'billing', label: 'checkpoint repair' },
      'checkpoint code-generation repair for billing',
    ],
    [
      { stageId: 'code-generation', label: 'review repair r2' },
      'checkpoint code-generation review repair r2',
    ],
    [{ kind: 'merge', unitSlug: 'auth' }, 'merge auth lane'],
    [{ kind: 'reconcile', unitSlug: 'auth' }, 'reconcile auth lane with the intent branch'],
    [{ kind: 'conflict-resolution', unitSlug: 'auth' }, 'resolve auth lane conflicts'],
  ])('%j has the subject %s', (options, subject) => {
    expect(message(options).split('\n')[0]).toBe(`chore(aidlc): ${subject}`);
  });

  it.each([
    ['initialization', 'docs'],
    ['ideation', 'docs'],
    ['inception', 'docs'],
    ['construction', 'chore'],
    ['operation', 'chore'],
    [null, 'chore'],
  ])('uses %s phase stage commits of type %s', (phase, type) => {
    expect(message({ stageId: 's', phase }).split('\n')[0]).toBe(
      `${type}(aidlc): checkpoint s stage`,
    );
    expect(message({ kind: 'merge', unitSlug: 'auth', phase }).split('\n')[0]).toBe(
      'chore(aidlc): merge auth lane',
    );
  });

  it('keeps stage trailers off lane merges', () => {
    expect(message({ kind: 'merge', unitSlug: 'auth' })).not.toContain('AIDLC-Stage');
  });

  it('keeps the header parseable and within 100 characters', () => {
    const header = message(
      { stageId: 'code-generation', unitSlug: `x${'y'.repeat(120)}`, label: 'repair (2): x' },
      { source: jira('ABCDEF-123456') },
    ).split('\n')[0];
    expect(header.length).toBeLessThanOrEqual(100);
    expect(header).toMatch(
      /^chore\(aidlc\): checkpoint code-generation repair .+ \[ABCDEF-123456\]$/,
    );
    // One header separator only, so parsers read type, scope and subject correctly.
    expect(header.match(/: /g)).toHaveLength(1);
  });

  it('puts the title on one line without emoji or control characters', () => {
    const body = message(
      { stageId: 'code-generation' },
      { title: `Fix\nlogin 🚀\u0007 ${'a'.repeat(200)}` },
    );
    const intentLine = body.split('\n').find((line) => line.startsWith('Intent: '));
    expect(intentLine).toMatch(/^Intent: Fix login a+\.\.\.$/);
    expect(intentLine.length).toBeLessThanOrEqual(100);
  });
});

describe('createEngineCommitMessages', () => {
  it('reads the intent once', async () => {
    const store = {
      getExecution: vi.fn(async () => ({ title: 'T', source: jira('ABC-1') })),
    };
    const messages = createEngineCommitMessages({ store, executionId: 'e1' });
    expect((await messages({ stageId: 's' })).split('\n')[0]).toBe(
      'chore(aidlc): checkpoint s stage [ABC-1]',
    );
    await messages({ stageId: 's', label: 'repair' });
    expect(store.getExecution).toHaveBeenCalledTimes(1);
    expect(store.getExecution).toHaveBeenCalledWith('e1');
  });

  it.each([
    ['rejects', { getExecution: async () => Promise.reject(new Error('down')) }],
    [
      'throws',
      {
        getExecution: () => {
          throw new Error('down');
        },
      },
    ],
    ['is missing', {}],
  ])('still writes a message when the read %s', async (_case, store) => {
    const messages = createEngineCommitMessages({ store, executionId: 'e1' });
    expect((await messages({ stageId: 's' })).split('\n')[0]).toBe(
      'chore(aidlc): checkpoint s stage',
    );
  });
});

describe('normaliseChangeDescription', () => {
  it.each([
    [{ type: 'fix', summary: 'Handle empty carts.' }, 'handle empty carts'],
    [{ type: 'fix', summary: 'fix(cart): handle empty carts' }, 'handle empty carts'],
    [
      { type: 'fix', summary: 'API returns 404 for empty carts' },
      'API returns 404 for empty carts',
    ],
    [{ type: 'docs', summary: 'note: ratio is 1:2' }, 'note ratio is 1:2'],
    [{ type: 'fix', summary: 'handle empty carts [ABC-12]' }, 'handle empty carts'],
    [{ type: 'fix', summary: '[ABC-12] Handle empty carts' }, 'handle empty carts'],
    [{ type: 'fix', summary: 'handle empty carts (ABC-12).' }, 'handle empty carts'],
    [
      { type: 'fix', summary: 'fix(cart): handle empty carts [A_B-1] [CD-2]' },
      'handle empty carts',
    ],
  ])('%j has the summary %s', (args, summary) => {
    expect(normaliseChangeDescription(args).summary).toBe(summary);
  });

  it('keeps breakingChange only for a breaking change', () => {
    expect(
      normaliseChangeDescription({ type: 'fix', summary: 'x', breakingChange: 'ignored' }),
    ).toEqual({ type: 'fix', scope: null, summary: 'x', breaking: false, breakingChange: null });
  });

  it('rejects a summary over 72 characters', () => {
    expect(() => normaliseChangeDescription({ type: 'fix', summary: 'a'.repeat(73) })).toThrow(
      /72 characters/,
    );
  });
});

describe('engineCommitMessage with a change description', () => {
  const intent = { title: 'Stagger renovate runs', source: jira('ABC-12') };
  const message = (options, description) =>
    engineCommitMessage({
      stageId: 'code-generation',
      executionId: 'e1',
      intent,
      description,
      ...options,
    });

  it("uses the agent's type, scope and summary for the stage commit", () => {
    expect(
      message(
        { unitSlug: 'billing' },
        { type: 'feat', scope: 'renovate', summary: 'stagger runs' },
      ),
    ).toBe(
      [
        'feat(renovate): stagger runs [ABC-12]',
        '',
        'Intent: Stagger renovate runs',
        '',
        'AIDLC-Stage: code-generation',
        'AIDLC-Unit: billing',
        'AIDLC-Execution: e1',
      ].join('\n'),
    );
  });

  it('appends the key once when the agent also wrote it in the summary', () => {
    expect(message({}, { type: 'fix', summary: 'round totals [ABC-12]' }).split('\n')[0]).toBe(
      'fix: round totals [ABC-12]',
    );
  });

  it('marks a breaking change in the header and the footer', () => {
    const lines = message(
      {},
      { type: 'feat', summary: 'drop the v1 API', breaking: true, breakingChange: 'use /v2' },
    ).split('\n');
    expect(lines[0]).toBe('feat!: drop the v1 API [ABC-12]');
    expect(lines).toContain('BREAKING CHANGE: use /v2');
    // Its own paragraph, ahead of the trailer block.
    const at = lines.indexOf('BREAKING CHANGE: use /v2');
    expect(lines[at - 1]).toBe('');
    expect(lines[at + 1]).toBe('');
    expect(at).toBeLessThan(lines.indexOf('AIDLC-Stage: code-generation'));
  });

  it('wraps a long breaking-change note to 100 columns without losing any of it', () => {
    const breakingChange =
      'the billing API now returns totals in minor units; clients must divide by 100 before ' +
      'display and migrate stored totals with scripts/migrate-totals.js during the release window';
    const text = message({}, { type: 'feat', summary: 'x', breaking: true, breakingChange });
    const lines = text.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    const start = lines.findIndex((line) => line.startsWith('BREAKING CHANGE: '));
    const end = lines.indexOf('', start);
    expect(end - start).toBeGreaterThan(1);
    // Every word survives, whole and in order.
    expect(lines.slice(start, end).join(' ').split(' ')).toEqual(
      `BREAKING CHANGE: ${breakingChange}`.split(' '),
    );
  });

  it('keeps a URL longer than a line whole, on its own line', () => {
    const url = `https://example.com/${'migrations/'.repeat(11)}minor-units`;
    expect(url.length).toBeGreaterThan(100);
    const breakingChange = `totals are now in minor units; migrate stored totals as described in ${url} before upgrading`;
    const text = message({}, { type: 'feat', summary: 'x', breaking: true, breakingChange });
    const lines = text.split('\n');
    expect(lines).toContain(url);
    // commitlint exempts lines containing a URL from its length rule.
    for (const line of lines) {
      if (!/\bhttps?:\/\/\S+/.test(line)) expect(line.length).toBeLessThanOrEqual(100);
    }
    const start = lines.findIndex((line) => line.startsWith('BREAKING CHANGE: '));
    const end = lines.indexOf('', start);
    expect(lines.slice(start, end).join(' ').split(' ')).toEqual(
      `BREAKING CHANGE: ${breakingChange}`.split(' '),
    );
  });

  it('splits a non-URL word longer than a line rather than dropping it', () => {
    const token = 'x'.repeat(150);
    const text = message({}, { type: 'feat', summary: 'x', breaking: true, breakingChange: token });
    const lines = text.split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
    const start = lines.indexOf('BREAKING CHANGE:');
    const end = lines.indexOf('', start);
    expect(lines.slice(start, end).join('')).toBe(`BREAKING CHANGE:${token}`);
  });

  it('uses the description for a labelled commit that holds the work, such as a lead draft', () => {
    expect(
      message({ label: 'lead draft' }, { type: 'feat', summary: 'stagger runs' }).split('\n')[0],
    ).toBe('feat: stagger runs [ABC-12]');
  });

  it('ignores the description for a lane merge', () => {
    expect(
      message({ kind: 'merge', unitSlug: 'auth' }, { type: 'feat', summary: 'stagger runs' }),
    ).toMatch(/^chore\(aidlc\): merge auth lane/);
  });

  it('falls back to chore for an invalid stored description', () => {
    expect(message({}, { type: 'feature', summary: 'x' }).split('\n')[0]).toBe(
      'chore(aidlc): checkpoint code-generation stage [ABC-12]',
    );
  });
});

describe('readCommitDescription and consumeCommitDescription', () => {
  const where = { executionId: 'e1', stageInstanceId: 'si-1' };

  it('reads the stage row consistently', async () => {
    const store = {
      getStage: vi.fn(async () => ({
        commitDescription: { type: 'fix', summary: 'x', descriptionId: 'd1' },
      })),
    };
    expect(await readCommitDescription({ store, ...where })).toMatchObject({
      type: 'fix',
      descriptionId: 'd1',
    });
    expect(store.getStage).toHaveBeenCalledWith('e1', 'si-1', { consistentRead: true });
  });

  it.each([
    ['has none', { getStage: async () => ({}) }],
    ['fails', { getStage: async () => Promise.reject(new Error('down')) }],
    ['holds an invalid one', { getStage: async () => ({ commitDescription: { type: 'x' } }) }],
  ])('returns null when the stage row %s', async (_case, store) => {
    expect(await readCommitDescription({ store, ...where })).toBeNull();
  });

  it('records the repositories that committed with the description, and never throws', async () => {
    const store = { recordCommitDescriptionUse: vi.fn(async () => true) };
    const gitResult = {
      results: [
        { repo: 'a', committed: true },
        { repo: 'b', committed: false, reason: 'commit_failed' },
        { repo: 'c', committed: true },
      ],
    };
    const description = { descriptionId: 'd1', committedRepos: ['c'] };
    await consumeCommitDescription({ store, ...where, description, gitResult });
    expect(store.recordCommitDescriptionUse).toHaveBeenCalledWith({
      ...where,
      descriptionId: 'd1',
      repos: ['a'],
    });
    await consumeCommitDescription({ store, ...where, description: null, gitResult });
    await consumeCommitDescription({
      store,
      ...where,
      description,
      gitResult: { results: [{ repo: 'b', committed: false }] },
    });
    expect(store.recordCommitDescriptionUse).toHaveBeenCalledTimes(1);
    const failing = { recordCommitDescriptionUse: async () => Promise.reject(new Error('down')) };
    await expect(
      consumeCommitDescription({ store: failing, ...where, description, gitResult }),
    ).resolves.toBeUndefined();
  });

  it('reads the repositories a commit already used the description in', async () => {
    const store = {
      getStage: async () => ({
        commitDescription: {
          type: 'fix',
          summary: 'x',
          descriptionId: 'd1',
          committedRepos: ['a'],
        },
      }),
    };
    expect(await readCommitDescription({ store, ...where })).toMatchObject({
      committedRepos: ['a'],
    });
  });
});

describe('stageCommitMessages', () => {
  const messageFor = async ({ description }) => (description ? 'feat: x' : 'chore: checkpoint');

  it('uses the description in every repository when none has used it', async () => {
    const description = { type: 'feat', summary: 'x', committedRepos: [] };
    expect(await stageCommitMessages({ messageFor, stageId: 's', description })).toEqual({
      message: 'feat: x',
    });
  });

  it('checkpoints only the repositories that already used it', async () => {
    const description = { type: 'feat', summary: 'x', committedRepos: ['a'] };
    expect(await stageCommitMessages({ messageFor, stageId: 's', description })).toEqual({
      message: 'feat: x',
      messages: { a: 'chore: checkpoint' },
    });
  });

  it('checkpoints every repository without a description', async () => {
    expect(await stageCommitMessages({ messageFor, stageId: 's' })).toEqual({
      message: 'chore: checkpoint',
    });
  });
});
