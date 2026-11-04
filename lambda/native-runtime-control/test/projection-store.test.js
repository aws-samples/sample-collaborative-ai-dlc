import { describe, expect, it } from 'vitest';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { nativeProjectionStatus } from '../projection-store.js';
import { serialFixture } from './execution-serial-fixtures.js';
import { TABLE } from './fixtures.js';

const projectionPut = (command) =>
  command instanceof TransactWriteCommand
    ? command.input.TransactItems.find((item) => item.Put?.Item.sk === 'PROJECTION')?.Put
    : undefined;
const progress = (f) =>
  structuredClone([...f.rows.values()].find((row) => row.sk === 'PROJECTION'));
const waiting = async () => {
  const f = serialFixture();
  await f.ready();
  await f.publish({ project: false });
  return f;
};

// These races use the production progress store and the fixture's interpreter
// for actual atomic DynamoDB conditions. Execution and graph leases are separate.
describe('projection owns its acknowledgements independently of execution', () => {
  it('has no work before a publication and cannot claim an execution lease for graph work', async () => {
    const f = serialFixture();
    await f.ready();
    const running = f.row();
    expect(await f.projection.claim(f.identity)).toEqual({ kind: 'missing' });
    expect(f.row()).toEqual(running);
    await f.publish({ project: false });
    const published = f.row();
    expect(await f.store.claim(f.bindingIdentity)).toEqual({ kind: 'terminal', row: published });
    const claim = await f.projection.claim(f.identity);
    expect(claim.kind).toBe('claimed');
    await f.projection.acknowledge(claim);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    expect(f.row()).toEqual(published);
  });

  it('acknowledges history while a subsequent reply owns the execution lease', async () => {
    const f = await waiting();
    const projection = await f.projection.claim(f.identity);
    await f.respond();
    const writer = await f.store.claim(f.bindingIdentity);
    const answer = await f.store.response(writer.row, writer.row.response.interactionId);
    await f.projection.acknowledge(projection);
    expect(f.row()).toEqual(writer.row);
    expect(await f.store.response(f.row(), answer.interactionId)).toEqual(answer);
    expect((await f.store.dispatchAttempted({ row: writer.row })).dispatch).toMatchObject({
      commandId: answer.commandId,
      sequence: 2,
    });
  });

  it.each(['acknowledge', 'release'])(
    'rejects stale %s after the projection lease expires and is reclaimed',
    async (operation) => {
      const f = await waiting();
      const execution = f.row();
      const stale = await f.projection.claim(f.identity);
      expect(await f.projection.claim(f.identity)).toEqual({ kind: 'busy' });
      f.tick();
      const successor = await f.projection.claim(f.identity);
      await expect(f.projection[operation](stale)).rejects.toMatchObject({
        code: 'NATIVE_PROJECTION_CONFLICT',
      });
      expect(progress(f)).toEqual(successor.progress);
      await f.projection.acknowledge(successor);
      expect(f.row()).toEqual(execution);
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    },
  );

  it.each(['acknowledge', 'release'])(
    'fences %s when takeover occurs between the ownership read and transaction',
    async (operation) => {
      const f = await waiting();
      const execution = f.row();
      const stale = await f.projection.claim(f.identity);
      let successor;
      f.hooks.before = async (command) => {
        if (!projectionPut(command)) return;
        delete f.hooks.before;
        f.tick();
        successor = await f.projection.claim(f.identity);
      };
      await expect(f.projection[operation](stale)).rejects.toMatchObject({
        code: 'NATIVE_PROJECTION_CONFLICT',
      });
      expect(progress(f)).toEqual(successor.progress);
      expect(f.row()).toEqual(execution);
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
      await f.projection.acknowledge(successor);
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    },
  );

  it('rejects acknowledgement when the source binding changes before its transaction', async () => {
    const f = await waiting();
    const execution = f.row();
    const claim = await f.projection.claim(f.identity);
    f.hooks.before = (command) => {
      if (!projectionPut(command)) return;
      delete f.hooks.before;
      for (const row of f.rows.values())
        if (row.sk === 'RUNTIME') row.bindingId = '328252d3-03c8-42ef-b2b0-4ca271f7c1b9';
    };
    await expect(f.projection.acknowledge(claim)).rejects.toMatchObject({
      code: 'NATIVE_PROJECTION_CONFLICT',
    });
    expect(progress(f)).toEqual(claim.progress);
    expect(f.row()).toEqual(execution);
  });

  it.each(['claim', 'acknowledge', 'release'])(
    'recovers only the exact committed %s after a lost transaction acknowledgement',
    async (operation) => {
      const f = await waiting();
      const execution = f.row();
      const claim = operation === 'claim' ? undefined : await f.projection.claim(f.identity);
      f.hooks.after = (command) => {
        if (!projectionPut(command)) return;
        delete f.hooks.after;
        throw Object.assign(new Error('Projection acknowledgement lost'), { name: 'TimeoutError' });
      };
      const result =
        operation === 'claim'
          ? await f.projection.claim(f.identity)
          : await f.projection[operation](claim);
      expect(result.progress ?? result).toEqual(progress(f));
      expect(f.row()).toEqual(execution);
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe(
        operation === 'acknowledge' ? 'complete' : 'pending',
      );
    },
  );

  it('does not adopt a successor after losing the release acknowledgement', async () => {
    const f = await waiting();
    const claim = await f.projection.claim(f.identity);
    let successor;
    f.hooks.after = async (command) => {
      if (!projectionPut(command)) return;
      delete f.hooks.after;
      successor = await f.projection.claim(f.identity);
      throw Object.assign(new Error('Projection acknowledgement lost'), { name: 'TimeoutError' });
    };
    await expect(f.projection.release(claim)).rejects.toMatchObject({
      code: 'NATIVE_PROJECTION_CONFLICT',
    });
    expect(progress(f)).toEqual(successor.progress);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('pending');
  });

  it.each(['pending', 'complete'])(
    'preserves %s progress and original publication identity through concurrent cancellations',
    async (state) => {
      const f = await waiting();
      const published = f.row();
      const claim = await f.projection.claim(f.identity);
      if (state === 'complete') await f.projection.acknowledge(claim);
      const cancelled = await Promise.all([
        f.store.cancel(f.bindingIdentity),
        f.store.cancel(f.bindingIdentity),
      ]);
      expect(cancelled[0]).toEqual(cancelled[1]);
      expect(f.row()).toMatchObject({
        epoch: published.epoch + 1,
        publicationEpoch: published.epoch,
        publication: published.publication,
      });
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe(state);
      if (state === 'pending') await f.projection.acknowledge(claim);
      expect(f.row()).toEqual(cancelled[0]);
      expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
    },
  );

  it('can acknowledge immutable history when cancellation races the progress transaction', async () => {
    const f = await waiting();
    const claim = await f.projection.claim(f.identity);
    let cancelled;
    f.hooks.before = async (command) => {
      if (!projectionPut(command)) return;
      delete f.hooks.before;
      cancelled = await f.store.cancel(f.bindingIdentity);
    };
    await f.projection.acknowledge(claim);
    expect(f.row()).toEqual(cancelled);
    expect(await nativeProjectionStatus(f.ddb, TABLE, f.row())).toBe('complete');
  });
});
