import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeApi } from '../api.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeExecutionStore } from '../execution-store.js';
import { nativePreparedConfigurationPins } from '../execution-config.js';
import { executionRuntimeConfiguration } from '../execution-runtime.js';
import { executionFixture } from './execution-fixtures.js';
import {
  ACTOR,
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  PROJECT,
  TABLE,
  binding,
  createInput,
  event,
  job,
  owner,
  pauseOnce,
  request,
  resources,
  setup,
} from './fixtures.js';

const promptCommand = (
  prompt = 'Build the saved task.\nKeep these exact bytes.  ',
  expectedRevision = 0,
) => ({
  requestId: randomUUID(),
  expectedRevision,
  prompt,
});
const route = (action, body) => {
  const base = event('get');
  return {
    ...base,
    httpMethod: 'POST',
    resource: `${base.resource}/${action}`,
    path: `${base.path}/${action}`,
    body: JSON.stringify(body),
  };
};
async function fixture({ ready = false } = {}) {
  const f = setup();
  await f.store.create(createInput({ request: request({ prompt: '' }) }));
  if (ready) {
    await f.store.prepare(IDENTITY);
    const claimed = (await f.store.claim({ ...IDENTITY, bindingId: f.read().bindingId })).row;
    await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
  }
  const executionStore = createNativeExecutionStore({
    ddb: f.ddb,
    tableName: TABLE,
    preparationStore: f.store,
    now: () => 1000,
  });
  const configure = vi.fn(async ({ draft }) => ({
    ...executionFixture().configuration,
    ...nativePreparedConfigurationPins(draft),
  }));
  const enqueue = vi.fn();
  const execution = createNativeExecutionApi({
    enabled: true,
    store: executionStore,
    configure,
    enqueue,
    authorizeSource: async () => {},
  });
  const membership = vi.fn(async () => MEMBERSHIP);
  const api = createNativeRuntimeApi({
    enabled: true,
    allowedProjectIds: [PROJECT],
    store: f.store,
    execution,
    image: IMAGE,
    getMembershipSnapshot: membership,
    workflowSources: { getAuthorizedBinding: async () => binding() },
    jobs: { get: async () => job() },
  });
  const save = (command, actorId = ACTOR) =>
    f.store.savePrompt({
      ...IDENTITY,
      actorId,
      projectIdentity: MEMBERSHIP.projectIdentity,
      request: command,
    });
  return { ...f, executionStore, configure, enqueue, membership, api, save };
}
const isPromptWrite = (command) =>
  command instanceof TransactWriteCommand &&
  command.input.TransactItems.some((item) => item.Put?.Item.sk.startsWith('PROMPT#'));
const isStartWrite = (command) =>
  command instanceof TransactWriteCommand &&
  command.input.TransactItems.some((item) => item.Put?.Item.sk === 'EXECUTION');

describe('pre-Start saved prompts', () => {
  it.each([false, true])(
    'edits a retained title-only draft (prepared=%s), retaining creation and pinning Start',
    async (ready) => {
      const f = await fixture({ ready });
      const original = f.read();
      expect(original).not.toHaveProperty('promptDraft');
      const command = promptCommand();
      const saved = await f.api(route('prompt', command));
      expect(saved.statusCode).toBe(200);
      expect(JSON.parse(saved.body)).toMatchObject({ prompt: command.prompt, promptRevision: 1 });
      expect(f.read()).toMatchObject({
        request: original.request,
        requestFingerprint: original.requestFingerprint,
        status: original.status,
      });
      expect(f.enqueue).not.toHaveBeenCalled();
      const retry = await f.api(event('create', { body: JSON.stringify(original.request) }));
      expect(retry.statusCode).toBe(200);
      expect(JSON.parse(retry.body)).toMatchObject({ prompt: command.prompt, promptRevision: 1 });
      if (!ready) {
        await f.store.prepare(IDENTITY);
        const claimed = (await f.store.claim({ ...IDENTITY, bindingId: original.bindingId })).row;
        await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
      }
      const started = await f.api(route('start', { requestId: randomUUID(), promptRevision: 1 }));
      expect(started.statusCode).toBe(202);
      const execution = await f.executionStore.get(IDENTITY);
      expect(execution.preparation.promptRevision).toBe(1);
      expect(execution.configuration.promptSha256).toBe(
        createHash('sha256').update(command.prompt).digest('hex'),
      );
      expect(executionRuntimeConfiguration(f.read(), execution).prompt).toBe(command.prompt);
      expect(
        (await f.api(route('prompt', promptCommand('Retarget execution', 1)))).statusCode,
      ).toBe(409);
      expect(await f.executionStore.get(IDENTITY)).toEqual(execution);
      expect(f.read().promptDraft.text).toBe(command.prompt);
    },
  );

  it('keeps exact receipts across repeated edits, another member, and Start', async () => {
    const f = await fixture({ ready: true });
    const first = promptCommand();
    const second = promptCommand('Second saved prompt', 1);
    await f.save(first);
    await f.save(second, 'member-two');
    expect((await f.save(first)).promptAcceptance).toMatchObject({
      prompt: first.prompt,
      revision: 1,
    });
    expect(f.read().promptDraft).toEqual({ text: second.prompt, revision: 2 });
    const start = { requestId: randomUUID(), promptRevision: 2 };
    expect((await f.api(route('start', start))).statusCode).toBe(202);
    expect((await f.api(route('start', start))).statusCode).toBe(202);
    expect((await f.save(second, 'member-two')).promptAcceptance.revision).toBe(2);
    await expect(
      f.save({ ...second, prompt: 'Changed identity body' }, 'member-two'),
    ).rejects.toMatchObject({ code: 'NATIVE_PROMPT_CONFLICT' });
  });

  it('preserves a save through preparation lease replacement without overwriting its content', async () => {
    const f = await fixture();
    await f.store.prepare(IDENTITY);
    const old = (await f.store.claim({ ...IDENTITY, bindingId: f.read().bindingId })).row;
    await f.save(promptCommand('Saved while preparation is active'));
    await expect(f.store.ready({ ...owner(old), resources: resources(old) })).rejects.toMatchObject(
      {
        code: 'NATIVE_PREPARATION_LEASE_LOST',
      },
    );
    f.setTime(1101);
    const current = (await f.store.claim({ ...IDENTITY, bindingId: old.bindingId })).row;
    await f.store.ready({ ...owner(current), resources: resources(current) });
    expect(f.read()).toMatchObject({
      status: 'READY',
      bindingId: old.bindingId,
      promptDraft: { revision: 1, text: 'Saved while preparation is active' },
    });
  });

  it('withholds a committed save after membership revocation without rolling it back', async () => {
    const f = await fixture();
    f.hooks.after = (command) => {
      if (isPromptWrite(command)) f.membership.mockResolvedValue(null);
    };
    const command = promptCommand();
    const result = await f.api(route('prompt', command));
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain(command.prompt);
    expect(f.read().promptDraft).toEqual({ text: command.prompt, revision: 1 });
  });

  it('does not admit a stale Start after the same prompt text is saved at a newer revision', async () => {
    const f = await fixture({ ready: true });
    const text = 'Identical text, independently saved';
    await f.save(promptCommand(text));
    const paused = pauseOnce(f, 'before', isStartWrite);
    const delayed = f.api(route('start', { requestId: randomUUID(), promptRevision: 1 }));
    await paused.started;
    await f.save(promptCommand(text, 1));
    expect(
      (await f.api(route('start', { requestId: randomUUID(), promptRevision: 2 }))).statusCode,
    ).toBe(202);
    paused.resume();
    expect((await delayed).statusCode).toBe(409);
    expect((await f.executionStore.get(IDENTITY)).preparation.promptRevision).toBe(2);
  });

  it.each(['', '  \n', 'bad\0text', 'x'.repeat(65537), '\ud800'])(
    'rejects invalid prompt without writing',
    async (prompt) => {
      const f = await fixture();
      const before = f.read();
      const result = await f.api(route('prompt', promptCommand(prompt)));
      expect(result.statusCode).toBe(400);
      expect(f.read()).toEqual(before);
      expect(f.rows.size).toBe(1);
    },
  );

  it('denies membership and requires a nonblank prompt and current revision at Start', async () => {
    const f = await fixture({ ready: true });
    expect(
      (await f.api(route('start', { requestId: randomUUID(), promptRevision: 0 }))).statusCode,
    ).toBe(409);
    f.membership.mockResolvedValue(null);
    expect((await f.api(route('prompt', promptCommand()))).statusCode).toBe(403);
    expect(f.read()).not.toHaveProperty('promptDraft');
    f.membership.mockResolvedValue(MEMBERSHIP);
    await f.save(promptCommand());
    for (const fields of [{}, { promptRevision: 0 }]) {
      expect((await f.api(route('start', { requestId: randomUUID(), ...fields }))).statusCode).toBe(
        409,
      );
    }
    expect(await f.executionStore.get(IDENTITY)).toBeNull();
  });

  it('recovers a lost save acknowledgement without a second revision', async () => {
    const f = await fixture();
    const command = promptCommand();
    let once = true;
    f.hooks.after = (write) => {
      if (once && isPromptWrite(write)) {
        once = false;
        throw new Error('Acknowledgement lost');
      }
    };
    const result = await f.save(command);
    expect(result.promptAcceptance.revision).toBe(1);
    expect((await f.save(command)).promptAcceptance).toEqual(result.promptAcceptance);
    expect(f.read().promptDraft.revision).toBe(1);
  });

  it('retains an unknown save outcome when its receipt cannot be read, then retries exactly', async () => {
    const f = await fixture();
    const command = promptCommand();
    f.hooks.after = (write) => {
      if (isPromptWrite(write)) {
        f.hooks.before = (read) => {
          if (read instanceof GetCommand && read.input.Key.sk.startsWith('PROMPT#'))
            throw new Error('Read unavailable');
        };
        throw new Error('Acknowledgement lost');
      }
    };
    await expect(f.save(command)).rejects.toMatchObject({ code: 'NATIVE_PROMPT_UNAVAILABLE' });
    delete f.hooks.before;
    delete f.hooks.after;
    expect((await f.save(command)).promptAcceptance.revision).toBe(1);
  });

  it('rejects a stale member edit at the transaction, preserving the winning content', async () => {
    const f = await fixture();
    const paused = pauseOnce(f, 'before', isPromptWrite);
    const first = f.save(promptCommand('First member'));
    await paused.started;
    await f.save(promptCommand('Second member'), 'member-two');
    paused.resume();
    await expect(first).rejects.toMatchObject({ code: 'NATIVE_PROMPT_CONFLICT' });
    expect(f.read().promptDraft).toEqual({ text: 'Second member', revision: 1 });
  });

  it.each(['edit', 'start'])(
    'atomically fences edit/Start when %s reaches the write last',
    async (last) => {
      const f = await fixture({ ready: true });
      await f.save(promptCommand('Initial saved prompt'));
      const paused = pauseOnce(f, 'before', last === 'edit' ? isPromptWrite : isStartWrite);
      const save = () => f.api(route('prompt', promptCommand('Concurrent edit', 1)));
      const start = () => f.api(route('start', { requestId: randomUUID(), promptRevision: 1 }));
      const delayed = last === 'edit' ? save() : start();
      await paused.started;
      expect((await (last === 'edit' ? start() : save())).statusCode).toBe(
        last === 'edit' ? 202 : 200,
      );
      paused.resume();
      expect((await delayed).statusCode).toBe(409);
      const execution = await f.executionStore.get(IDENTITY);
      if (last === 'edit') {
        expect(f.read().promptDraft.text).toBe('Initial saved prompt');
        expect(execution.preparation.promptRevision).toBe(1);
      } else {
        expect(execution).toBeNull();
        expect(f.read().promptDraft.text).toBe('Concurrent edit');
      }
    },
  );
});
