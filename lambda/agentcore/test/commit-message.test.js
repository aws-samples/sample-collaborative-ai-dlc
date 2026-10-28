import { describe, it, expect, vi } from 'vitest';
import {
  commitStyle,
  consumeCommitDescription,
  createEngineCommitMessages,
  engineCommitMessage,
  normaliseChangeDescription,
  readCommitDescription,
  trackerKey,
} from '../commit-message.js';

const jira = (resourceId, over = {}) => ({
  bindingId: 'b1',
  provider: 'jira-cloud',
  resourceType: 'issue',
  resourceId,
  ...over,
});

describe('commitStyle', () => {
  it.each([
    [{}, 'aidlc'],
    [{ ENGINE_COMMIT_STYLE: 'aidlc' }, 'aidlc'],
    [{ ENGINE_COMMIT_STYLE: 'Conventional' }, 'aidlc'],
    [{ ENGINE_COMMIT_STYLE: 'conventional' }, 'conventional'],
  ])('%j is %s', (env, style) => {
    expect(commitStyle(env)).toBe(style);
  });
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

describe('engineCommitMessage, aidlc style', () => {
  it.each([
    [{ stageId: 'code-generation' }, 'aidlc(code-generation): e1'],
    [{ stageId: 'code-generation', unitSlug: 'billing' }, 'aidlc(code-generation): billing — e1'],
    [
      { stageId: 'code-generation', unitSlug: 'billing', label: 'lead draft' },
      'aidlc(code-generation): billing — e1 (lead draft)',
    ],
    [{ stageId: 'functional-design', label: 'repair' }, 'aidlc(functional-design): e1 (repair)'],
    [{ kind: 'merge', unitSlug: 'auth' }, 'aidlc(merge): auth — e1'],
    [{ kind: 'reconcile', unitSlug: 'auth' }, 'aidlc(reconcile): auth - e1'],
    [{ kind: 'conflict-resolution', unitSlug: 'auth' }, 'aidlc(conflict-resolution): auth — e1'],
  ])('%j', (options, message) => {
    expect(
      engineCommitMessage({ ...options, executionId: 'e1', intent: { source: jira('ABC-1') } }),
    ).toBe(message);
  });
});

describe('engineCommitMessage, conventional style', () => {
  const message = (options, intent = null) =>
    engineCommitMessage({ executionId: 'e1', style: 'conventional', intent, ...options });

  it('writes a Conventional Commits header with the Jira key and attribution trailers', () => {
    expect(
      message(
        { stageId: 'code-generation', unitSlug: 'billing' },
        { title: 'Stagger renovate runs', source: jira('ABC-12') },
      ),
    ).toBe(
      [
        'chore(aidlc): code-generation stage for billing [ABC-12]',
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
      'chore(aidlc): requirements-analysis stage\n\nAIDLC-Stage: requirements-analysis\nAIDLC-Execution: e1',
    );
  });

  it.each([
    [{ stageId: 'code-generation', label: 'lead draft' }, 'code-generation stage, lead draft'],
    [{ kind: 'merge', unitSlug: 'auth' }, 'merge auth lane'],
    [{ kind: 'reconcile', unitSlug: 'auth' }, 'reconcile auth lane with the intent branch'],
    [{ kind: 'conflict-resolution', unitSlug: 'auth' }, 'resolve auth lane conflicts'],
  ])('%j has the subject %s', (options, subject) => {
    expect(message(options).split('\n')[0]).toBe(`chore(aidlc): ${subject}`);
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
    expect(header).toMatch(/^chore\(aidlc\): [^():]+ \[ABCDEF-123456\]$/);
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
  it('reads the intent once, and only in the conventional style', async () => {
    const store = {
      getExecution: vi.fn(async () => ({ title: 'T', source: jira('ABC-1') })),
    };
    const legacy = createEngineCommitMessages({ store, executionId: 'e1', env: {} });
    expect(await legacy({ stageId: 's' })).toBe('aidlc(s): e1');
    expect(store.getExecution).not.toHaveBeenCalled();

    const conventional = createEngineCommitMessages({
      store,
      executionId: 'e1',
      env: { ENGINE_COMMIT_STYLE: 'conventional' },
    });
    expect((await conventional({ stageId: 's' })).split('\n')[0]).toBe(
      'chore(aidlc): s stage [ABC-1]',
    );
    await conventional({ stageId: 's', label: 'repair' });
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
    const messages = createEngineCommitMessages({
      store,
      executionId: 'e1',
      env: { ENGINE_COMMIT_STYLE: 'conventional' },
    });
    expect((await messages({ stageId: 's' })).split('\n')[0]).toBe('chore(aidlc): s stage');
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
      style: 'conventional',
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

  it('marks a breaking change in the header and the footer', () => {
    const lines = message(
      {},
      { type: 'feat', summary: 'drop the v1 API', breaking: true, breakingChange: 'use /v2' },
    ).split('\n');
    expect(lines[0]).toBe('feat!: drop the v1 API [ABC-12]');
    expect(lines).toContain('BREAKING CHANGE: use /v2');
    expect(lines.indexOf('BREAKING CHANGE: use /v2')).toBeLessThan(
      lines.indexOf('AIDLC-Stage: code-generation'),
    );
  });

  it.each([
    ['a lead draft or repair commit', { label: 'lead draft' }],
    ['a lane merge', { kind: 'merge', unitSlug: 'auth' }],
  ])('ignores the description for %s', (_case, options) => {
    expect(message(options, { type: 'feat', summary: 'stagger runs' })).toMatch(
      /^chore\(aidlc\): /,
    );
  });

  it('falls back to chore for an invalid stored description', () => {
    expect(message({}, { type: 'feature', summary: 'x' }).split('\n')[0]).toBe(
      'chore(aidlc): code-generation stage [ABC-12]',
    );
  });

  it('ignores the description in the aidlc style', () => {
    expect(
      engineCommitMessage({
        stageId: 's',
        executionId: 'e1',
        description: { type: 'feat', summary: 'x' },
      }),
    ).toBe('aidlc(s): e1');
  });
});

describe('readCommitDescription and consumeCommitDescription', () => {
  const env = { ENGINE_COMMIT_STYLE: 'conventional' };
  const where = { executionId: 'e1', stageInstanceId: 'si-1' };

  it('reads the stage row consistently, only in the conventional style', async () => {
    const store = {
      getStage: vi.fn(async () => ({
        commitDescription: { type: 'fix', summary: 'x', descriptionId: 'd1' },
      })),
    };
    expect(await readCommitDescription({ store, ...where, env: {} })).toBeNull();
    expect(store.getStage).not.toHaveBeenCalled();
    expect(await readCommitDescription({ store, ...where, env })).toMatchObject({
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
    expect(await readCommitDescription({ store, ...where, env })).toBeNull();
  });

  it('clears the description it used, and never throws', async () => {
    const store = { clearCommitDescription: vi.fn(async () => true) };
    await consumeCommitDescription({ store, ...where, description: { descriptionId: 'd1' } });
    expect(store.clearCommitDescription).toHaveBeenCalledWith({ ...where, descriptionId: 'd1' });
    await consumeCommitDescription({ store, ...where, description: null });
    expect(store.clearCommitDescription).toHaveBeenCalledTimes(1);
    const failing = { clearCommitDescription: async () => Promise.reject(new Error('down')) };
    await expect(
      consumeCommitDescription({ store: failing, ...where, description: { descriptionId: 'd1' } }),
    ).resolves.toBeUndefined();
  });
});
