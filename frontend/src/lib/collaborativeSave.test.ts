import { describe, expect, it, vi } from 'vitest';
import { saveCollaborativeProjection } from './collaborativeSave';

describe('collaborative business projection', () => {
  it('re-reads the CRDT after the receipt and retries a delayed write with a fresh revision', async () => {
    let revision = 0;
    let business = '';
    let crdt = 'A';
    const readVersion = vi.fn(async () => revision);
    const flush = vi.fn(async () => {
      // A remote edit arrives while the local checkpoint is in flight.
      if (crdt === 'A') crdt = 'AB';
    });
    const attempts: { value: string; expected: number }[] = [];
    await saveCollaborativeProjection({
      readVersion,
      flush,
      readData: () => crdt,
      write: async (value, expected) => {
        attempts.push({ value, expected });
        if (attempts.length === 1) {
          // A second editor's REST request beats the delayed first request.
          crdt = business = 'ABC';
          revision++;
        }
        if (expected !== revision) throw { status: 409, body: { code: 'edit_conflict' } };
        business = value;
        revision++;
      },
    });
    expect(attempts).toEqual([
      { value: 'AB', expected: 0 },
      { value: 'ABC', expected: 1 },
    ]);
    expect(readVersion).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(business).toBe('ABC');
  });

  it('bounds contention retries and propagates lifecycle/authorization errors', async () => {
    const conflict = { status: 409, body: { code: 'edit_conflict' } };
    const write = vi.fn().mockRejectedValue(conflict);
    const args = { readVersion: async () => 0, flush: async () => {}, readData: () => 'A', write };
    await expect(saveCollaborativeProjection(args)).rejects.toBe(conflict);
    expect(write).toHaveBeenCalledTimes(3);
    write.mockClear().mockRejectedValue({ status: 409, body: { code: 'artifact_replaced' } });
    await expect(saveCollaborativeProjection(args)).rejects.toMatchObject({ status: 409 });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
