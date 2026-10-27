// The collaborative slice of a DRAFT intent, with TWO real Yjs documents.
//
// A single member editing in sequence proves nothing about a CRDT: the whole
// question is what two members do to each other's work. These tests drive the
// real hook twice over two real documents and exchange their updates by hand,
// which is the in-process equivalent of the WebSocket provider.
//
// The AI-DLC settings are the interesting case. They are ORDINARY SELECTION
// STATE: a top-level `Y.Map` with one entry per setting, merged per key, saved
// by the existing debounced PATCH in the same payload as the scope, and flushed
// by the existing Start barrier. Nothing is published back from the server, so
// the interleavings below are the same ones `scope` already has.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';

const transport = vi.hoisted(() => ({
  peers: new Map<string, { doc: Y.Doc; flushDocument: ReturnType<typeof vi.fn> }>(),
}));
const api = vi.hoisted(() => ({
  update: vi.fn(),
  draftEditState: vi.fn(),
}));

vi.mock('../services/intents', () => ({ intentsService: api }));
vi.mock('./useYjsDocument', () => ({
  useYjsDocument: (id: string, name: string) => {
    // A member who navigates between drafts registers one peer per document
    // id; a member who stays on one draft registers a single peer by name.
    const peer = (transport.peers.get(`${name}/${id}`) ?? transport.peers.get(name))!;
    const [localRevision, setRevision] = useState(0);
    useEffect(() => {
      const changed = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tx: Y.Transaction) => {
        if (tx.local) setRevision((n) => n + 1);
      };
      peer.doc.on('update', changed);
      return () => peer.doc.off('update', changed);
    }, [peer]);
    return { ...peer, synced: true, localRevision, remoteUsers: new Map(), setCursor: vi.fn() };
  },
}));

import { useCollaborativeIntentDraft } from './useCollaborativeIntentDraft';

const member = (name: string) => {
  const peer = { doc: new Y.Doc(), flushDocument: vi.fn().mockResolvedValue(undefined) };
  transport.peers.set(name, peer);
  return { ...renderHook(() => useCollaborativeIntentDraft('p1', 'i1', name)), doc: peer.doc };
};

const sync = (a: Y.Doc, b: Y.Doc) => {
  const fromA = Y.encodeStateAsUpdate(a);
  const fromB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, fromB, 'remote');
  Y.applyUpdate(b, fromA, 'remote');
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const intent = (extra = {}) =>
  ({
    id: 'i1',
    title: 'An intent',
    prompt: 'Build X',
    scope: 'classic',
    draftRevision: 7,
    ...extra,
  }) as any;

const CLASSIC_AUTHORED = { guardPolicy: 'off', planApproval: 'on', collaborators: 'off' };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.update.mockReset().mockResolvedValue(intent({ draftRevision: 8 }));
  api.draftEditState.mockReset().mockResolvedValue({ draftRevision: 7 });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  transport.peers.clear();
});

const bothSeeded = (extra = {}) => {
  const a = member('Alice');
  const b = member('Bob');
  act(() => {
    a.result.current.initFromIntent(intent(extra));
    b.result.current.initFromIntent(intent(extra));
    sync(a.doc, b.doc);
  });
  return { a, b };
};

describe('useCollaborativeIntentDraft — choosing an AI-DLC setting', () => {
  it('is a local synchronous change both members see', () => {
    const { a, b } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
    });
    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'strict' });

    act(() => sync(a.doc, b.doc));
    expect(b.result.current.aidlcSettings).toEqual({ guardPolicy: 'strict' });
  });

  it('follows the scope default again when the entry is cleared', () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
      a.result.current.setAidlcSetting('guardPolicy', null);
    });

    expect(a.result.current.aidlcSettings).toBeNull();
  });

  // The map merges per KEY, so two members changing different settings
  // concurrently both survive with no revision bookkeeping anywhere.
  it('keeps both members’ choices when they change different settings', () => {
    const { a, b } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
      b.result.current.setAidlcSetting('collaborators', 'on');
    });
    act(() => sync(a.doc, b.doc));

    const expected = { guardPolicy: 'strict', collaborators: 'on' };
    expect(a.result.current.aidlcSettings).toEqual(expected);
    expect(b.result.current.aidlcSettings).toEqual(expected);
  });

  // The SAME setting is last-writer-wins, identical to two members changing the
  // scope, and the two documents converge on one answer. Whichever CRDT order
  // wins, both pages agree — which is the property that matters, and the one
  // the server-answer design could not provide.
  it('converges on one value when both change the same setting', () => {
    const { a, b } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
      b.result.current.setAidlcSetting('guardPolicy', 'relaxed');
    });
    act(() => sync(a.doc, b.doc));

    expect(a.result.current.aidlcSettings).toEqual(b.result.current.aidlcSettings);
    expect(['strict', 'relaxed']).toContain(a.result.current.aidlcSettings!.guardPolicy);
  });
});

describe('useCollaborativeIntentDraft — persisting the AI-DLC settings', () => {
  it('sends them in the same payload as the selection', async () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
    });
    await act(async () => {
      await a.result.current.flushDraft();
    });

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][2]).toMatchObject({
      scope: 'classic',
      composedGrid: null,
      aidlcSettings: { guardPolicy: 'strict' },
      ifDraftRevision: 7,
    });
  });

  // There is no second in-flight operation for Start to await, so a choice made
  // one tick before Start is in the payload the existing barrier flushes.
  it('persists a setting chosen one tick before Start', async () => {
    const { a } = bothSeeded();

    let flushed: Promise<unknown> | null = null;
    act(() => {
      a.result.current.setAidlcSetting('planApproval', 'off');
      flushed = a.result.current.flushDraft();
    });
    await act(async () => {
      await flushed;
    });

    expect(api.update.mock.calls.at(-1)![2].aidlcSettings).toEqual({ planApproval: 'off' });
  });

  // A draft that has never had a setting sends NO settings field: that is the
  // body every unpinned, 2.3.3, 2.8.2 and 2.9.0 draft sent before these
  // settings existed, and it keeps those drafts off the server's settings path
  // entirely.
  it('sends no settings field for a draft that has none', async () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.setTitle('Renamed');
    });
    await act(async () => {
      await a.result.current.flushDraft();
    });

    expect(api.update.mock.calls[0][2]).not.toHaveProperty('aidlcSettings');
  });

  // Once the draft has had one, the field is sent even when it is now empty —
  // otherwise clearing the LAST override could not reach the server.
  it('sends null once the last override is cleared', async () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
    });
    await act(async () => {
      await a.result.current.flushDraft();
    });
    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', null);
    });
    await act(async () => {
      await a.result.current.flushDraft();
    });

    expect(api.update.mock.calls.at(-1)![2].aidlcSettings).toBeNull();
  });

  // The settings are seeded INSIDE the empty-document seed, exactly like the
  // scope, so a mount is not a local edit and a hydration of a draft with no
  // settings writes nothing at all.
  it('makes no request when a hydration changed nothing', async () => {
    const a = member('Alice');
    act(() => {
      a.result.current.initFromIntent(intent());
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(api.update).not.toHaveBeenCalled();
    expect(api.draftEditState).not.toHaveBeenCalled();
  });

  it('makes no request when a hydration carried settings either', async () => {
    const a = member('Alice');
    act(() => {
      a.result.current.initFromIntent(intent({ aidlcSettings: { guardPolicy: 'strict' } }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'strict' });
    expect(api.update).not.toHaveBeenCalled();
  });
});

describe('useCollaborativeIntentDraft — pruning the settings a selection drops', () => {
  it('withdraws an unauthored setting in one transaction and names it', () => {
    const { a, b } = bothSeeded({ scope: 'bugfix', aidlcSettings: { existingCode: false } });
    let updates = 0;
    a.doc.on('update', () => {
      updates += 1;
    });

    let dropped: string[] = [];
    act(() => {
      dropped = a.result.current.pruneAidlcSettings(CLASSIC_AUTHORED);
    });

    expect(dropped).toEqual(['existingCode']);
    expect(a.result.current.aidlcSettings).toBeNull();
    expect(updates).toBe(1);

    act(() => sync(a.doc, b.doc));
    expect(b.result.current.aidlcSettings).toBeNull();
  });

  it('withdraws an override equal to the new scope default', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
    });

    act(() => {
      a.result.current.pruneAidlcSettings({ ...CLASSIC_AUTHORED, guardPolicy: 'strict' });
    });

    expect(a.result.current.aidlcSettings).toBeNull();
  });

  // A selection that authors the same settings must write NOTHING: an
  // unconditional rewrite would make every preview a local edit and every
  // mount an autosave.
  it('writes nothing when the selection authors the same settings', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.setAidlcSetting('guardPolicy', 'strict');
    });
    let updates = 0;
    a.doc.on('update', () => {
      updates += 1;
    });

    let dropped: string[] = [];
    act(() => {
      dropped = a.result.current.pruneAidlcSettings(CLASSIC_AUTHORED);
    });

    expect(dropped).toEqual([]);
    expect(updates).toBe(0);
    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'strict' });
  });

  it('withdraws every setting for a selection that authors none', () => {
    const { a } = bothSeeded({ aidlcSettings: { guardPolicy: 'strict', collaborators: 'on' } });

    let dropped: string[] = [];
    act(() => {
      dropped = a.result.current.pruneAidlcSettings(null);
    });

    expect(dropped.toSorted()).toEqual(['collaborators', 'guardPolicy']);
    expect(a.result.current.aidlcSettings).toBeNull();
  });
});

// A save belongs to the document it read, and that document can retire while
// its request is still in flight: the revision read is awaited before the
// payload is taken. Navigating to another draft must therefore not change how
// the earlier save serializes ITS document — the settings-presence state that
// decides whether `aidlcSettings` is in the body is owned by that document, not
// by whichever draft the page happens to show when the response lands.
describe('useCollaborativeIntentDraft — a save that outlives its document', () => {
  const deferred = () => {
    let release!: (value: { draftRevision: number }) => void;
    const promise = new Promise<{ draftRevision: number }>((resolve) => {
      release = resolve;
    });
    return { promise, release: () => release({ draftRevision: 7 }) };
  };

  // One hook instance, two real documents, navigated by changing the intent id
  // exactly as the router does.
  const navigating = (ids: string[]) => {
    const docs = new Map<string, Y.Doc>();
    for (const id of ids) {
      const peer = { doc: new Y.Doc(), flushDocument: vi.fn().mockResolvedValue(undefined) };
      transport.peers.set(`Alice/intent-draft-${id}`, peer);
      docs.set(id, peer.doc);
    }
    const hook = renderHook(
      ({ intentId }: { intentId: string }) => useCollaborativeIntentDraft('p1', intentId, 'Alice'),
      { initialProps: { intentId: ids[0] } },
    );
    return { ...hook, docs };
  };

  const bodyFor = (intentId: string) =>
    api.update.mock.calls.filter((call) => call[1] === intentId).at(-1)?.[2];

  // `guardPolicy=strict` on A, A's revision read delayed, navigate to B which
  // has no settings at all, then release A's response.
  it('sends the retiring document’s own settings after navigation', async () => {
    const first = deferred();
    api.draftEditState.mockImplementation((_projectId: string, intentId: string) =>
      intentId === 'A' ? first.promise : Promise.resolve({ draftRevision: 3 }),
    );
    const page = navigating(['A', 'B']);

    act(() => {
      page.result.current.initFromIntent(intent({ id: 'A' }));
    });
    act(() => {
      page.result.current.setAidlcSetting('guardPolicy', 'strict');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    page.rerender({ intentId: 'B' });
    act(() => {
      page.result.current.initFromIntent(intent({ id: 'B', scope: 'bugfix' }));
    });
    await act(async () => {
      first.release();
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(bodyFor('A')).toMatchObject({
      title: 'An intent',
      prompt: 'Build X',
      scope: 'classic',
      aidlcSettings: { guardPolicy: 'strict' },
      ifDraftRevision: 7,
    });
    expect(page.result.current.aidlcSettings).toBeNull();
    expect(bodyFor('B')).toBeUndefined();
  });

  // Clearing the LAST override needs the same ownership: the retiring document
  // has an empty map, so only its own sticky presence state can still send the
  // explicit `null` that clears the stored settings.
  it('sends an explicit null for a cleared override after navigation', async () => {
    const first = deferred();
    api.draftEditState.mockImplementation((_projectId: string, intentId: string) =>
      intentId === 'A' ? first.promise : Promise.resolve({ draftRevision: 3 }),
    );
    const page = navigating(['A', 'B']);

    act(() => {
      page.result.current.initFromIntent(
        intent({ id: 'A', aidlcSettings: { guardPolicy: 'strict' } }),
      );
    });
    act(() => {
      page.result.current.setAidlcSetting('guardPolicy', null);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    page.rerender({ intentId: 'B' });
    act(() => {
      page.result.current.initFromIntent(intent({ id: 'B', scope: 'bugfix' }));
    });
    await act(async () => {
      first.release();
      await vi.advanceTimersByTimeAsync(2500);
    });

    const body = bodyFor('A');
    expect(body).toHaveProperty('aidlcSettings');
    expect(body!.aidlcSettings).toBeNull();
    expect(page.result.current.scope).toBe('bugfix');
    expect(bodyFor('B')).toBeUndefined();
  });

  // B is a draft with no settings, so ITS save keeps the pre-2.11 body even
  // though the draft the member came from had one.
  it('keeps the next document’s own request shape', async () => {
    api.draftEditState.mockResolvedValue({ draftRevision: 3 });
    const page = navigating(['A', 'B']);

    act(() => {
      page.result.current.initFromIntent(
        intent({ id: 'A', aidlcSettings: { guardPolicy: 'strict' } }),
      );
    });
    page.rerender({ intentId: 'B' });
    act(() => {
      page.result.current.initFromIntent(intent({ id: 'B', scope: 'bugfix' }));
    });
    act(() => {
      page.result.current.setTitle('Renamed');
    });
    await act(async () => {
      await page.result.current.flushDraft();
    });

    expect(bodyFor('B')).not.toHaveProperty('aidlcSettings');
  });
});

// Accepting a composed plan: Apply is ONE local transaction, so there is no
// asynchronous result to inspect, nothing partial to recover from, and no
// ordering between persisting the selection and recording the settings.
describe('useCollaborativeIntentDraft — applying a composed plan', () => {
  it('writes the scope, the grid, its base scope and the settings in one transaction', () => {
    const { a, b } = bothSeeded();
    let updates = 0;
    a.doc.on('update', () => {
      updates += 1;
    });

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE', build: 'SKIP' },
        policyScope: 'enterprise',
        aidlcSettings: { guardPolicy: 'relaxed' },
      });
    });

    expect(updates).toBe(1);
    expect(a.result.current.scope).toBe('enterprise-custom');
    expect(a.result.current.composedGrid).toEqual({ init: 'EXECUTE', build: 'SKIP' });
    expect(a.result.current.policyScope).toBe('enterprise');
    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'relaxed' });

    act(() => sync(a.doc, b.doc));
    expect(b.result.current.policyScope).toBe('enterprise');
    expect(b.result.current.aidlcSettings).toEqual({ guardPolicy: 'relaxed' });
  });

  it('sends the whole accepted selection in one save body', async () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE' },
        policyScope: 'enterprise',
        aidlcSettings: { guardPolicy: 'relaxed' },
      });
    });
    await act(async () => {
      await a.result.current.flushDraft();
    });

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][2]).toMatchObject({
      scope: 'enterprise-custom',
      composedGrid: { init: 'EXECUTE' },
      policyScope: 'enterprise',
      aidlcSettings: { guardPolicy: 'relaxed' },
    });
  });

  // A matched proposal replaces the selection with a stock scope, so the grid
  // and the base scope it belonged to both go.
  it('clears the grid and its base scope for a matched proposal', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE' },
        policyScope: 'enterprise',
      });
    });

    act(() => {
      a.result.current.applyComposedSelection({ scope: 'classic' });
    });

    expect(a.result.current.scope).toBe('classic');
    expect(a.result.current.composedGrid).toBeNull();
    expect(a.result.current.policyScope).toBeNull();
  });

  // A matched proposal also drops the per-intent skip overlay: the stock scope
  // it names describes the whole run, so an overlay built on the selection the
  // member just replaced goes with it.
  it('drops the skip overlay for a matched proposal', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.setSkipStageIds(['build']);
    });

    act(() => {
      a.result.current.applyComposedSelection({ scope: 'classic' });
    });

    expect(a.result.current.skipStageIds).toBeNull();
  });

  // A CUSTOM proposal does not: the overlay and the grid are different
  // mechanisms, so the overlay is pruned against the grid exactly as
  // `setComposedGrid` prunes it. Dropping it instead would make a stage the
  // team had excluded run again as soon as a custom plan was accepted.
  it('keeps the skips a custom proposal still executes and prunes the rest', () => {
    const { a, b } = bothSeeded();
    act(() => {
      a.result.current.setSkipStageIds(['build', 'design']);
    });

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE', build: 'EXECUTE', design: 'SKIP' },
        policyScope: 'enterprise',
      });
    });

    expect(a.result.current.skipStageIds).toEqual(['build']);

    act(() => sync(a.doc, b.doc));
    expect(b.result.current.skipStageIds).toEqual(['build']);
  });

  // The overlay goes only when the grid excludes every entry in it, so the
  // draft never carries a skip the resolver would reject.
  it('clears the overlay when the accepted grid excludes every skip', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.setSkipStageIds(['build']);
    });

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE', build: 'SKIP' },
        policyScope: 'enterprise',
      });
    });

    expect(a.result.current.skipStageIds).toBeNull();
  });

  // An override the proposal does not carry goes back to the scope default:
  // accepting a whole plan must not leave a setting from the selection the
  // member just replaced.
  it('withdraws an override the accepted plan does not carry', () => {
    const { a } = bothSeeded();
    act(() => {
      a.result.current.setAidlcSetting('collaborators', 'on');
    });

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'classic',
        aidlcSettings: { guardPolicy: 'strict' },
      });
    });

    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'strict' });
  });

  // A scope change the member makes right after Apply simply wins, because both
  // are local writes to the same document. There is no in-flight acceptance for
  // it to corrupt.
  it('lets a later scope change win with no in-flight acceptance to corrupt', () => {
    const { a } = bothSeeded();

    act(() => {
      a.result.current.applyComposedSelection({
        scope: 'enterprise-custom',
        composedGrid: { init: 'EXECUTE' },
        policyScope: 'enterprise',
        aidlcSettings: { guardPolicy: 'relaxed' },
      });
      a.result.current.setScope('express');
    });

    expect(a.result.current.scope).toBe('express');
    expect(a.result.current.aidlcSettings).toEqual({ guardPolicy: 'relaxed' });

    // The preview for the new selection prunes what it does not author, which
    // is the only correction path and it is local.
    act(() => {
      a.result.current.pruneAidlcSettings({ planApproval: 'off' });
    });
    expect(a.result.current.aidlcSettings).toBeNull();
  });
});
