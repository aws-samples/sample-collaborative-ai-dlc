import { useEffect, useState, useCallback, useRef } from 'react';
import * as Y from 'yjs';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';
import { saveCollaborativeProjection } from '../lib/collaborativeSave';
import { generateColor } from '../utils/colors';
import { seedYjsDocumentIfEmpty } from '../lib/yjsSeed';
import { intentsService, type Intent } from '../services/intents';
import {
  AIDLC_SETTING_KEYS,
  normalizeAidlcSettings,
  type AidlcSettingValue,
} from '../lib/aidlcSettings';

// The collaboratively edited slice of a DRAFT intent. Clustered Yjs checkpoints
// the CRDT; debounced PATCH saves maintain the intent's business-data META row.
// Standalone Yjs relies on that META row when its idle documents are evicted.
// Shapes:
//   Y.Text 'title' / 'prompt'      — diff-based collaborative text
//   Y.Map  'config'                — LWW atomic-replace selection state:
//     scope: string                — scope name or composed-grid label
//     composedGrid: JSON string    — {stageId: EXECUTE|SKIP} or absent
//     skipStageIds: JSON string    — string[] or absent
//   Y.Map  'aidlcSettings'         — LWW per SETTING KEY: settingKey -> scalar
//     override. An absent entry follows the pinned scope's own default. Per-key
//     rather than one atomic blob so two members changing DIFFERENT settings
//     concurrently both survive, which is the same resolution
//     useCollaborativeStructuredAnswer's selections map already uses.
export interface IntentDraftState {
  title: string;
  prompt: string;
  scope: string | null;
  composedGrid: Record<string, 'EXECUTE' | 'SKIP'> | null;
  // The stock scope a composed grid runs on. Collaborative like the grid
  // itself: it decides which settings the whole team is offered, and the API
  // verifies it before any plan reads it.
  policyScope: string | null;
  skipStageIds: string[] | null;
  // The per-intent AI-DLC settings the TEAM has chosen: the overrides on top of
  // the pinned scope's defaults. Ordinary collaborative selection state, like
  // `scope` — not a server answer republished into the document, so there is
  // nothing here to order against a response in flight.
  aidlcSettings: Record<string, AidlcSettingValue> | null;
}

const AIDLC_SETTINGS_MAP = 'aidlcSettings';

const readAidlcSettings = (doc: Y.Doc): Record<string, AidlcSettingValue> | null => {
  const entries = [...doc.getMap<AidlcSettingValue>(AIDLC_SETTINGS_MAP).entries()].filter(
    ([, value]) => value !== undefined && value !== null,
  );
  return entries.length ? Object.fromEntries(entries) : null;
};

const parseJson = <T>(raw: unknown): T | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const readConfig = (
  config: Y.Map<unknown>,
): Omit<IntentDraftState, 'title' | 'prompt' | 'aidlcSettings'> => {
  const scope = config.get('scope');
  const policyScope = config.get('policyScope');
  return {
    scope: typeof scope === 'string' && scope ? scope : null,
    composedGrid: parseJson<Record<string, 'EXECUTE' | 'SKIP'>>(config.get('composedGrid')),
    policyScope: typeof policyScope === 'string' && policyScope ? policyScope : null,
    skipStageIds: parseJson<string[]>(config.get('skipStageIds')),
  };
};

export function useCollaborativeIntentDraft(
  projectId: string,
  intentId: string | null,
  userName: string,
) {
  const {
    doc,
    synced,
    awareness,
    remoteUsers,
    setCursor,
    localRevision,
    flushDocument,
    beforeDisconnect,
  } = useYjsDocument(
    intentId ? `intent-draft-${intentId}` : null,
    userName,
    generateColor(userName),
    intentId ? { intentId, projectId } : undefined,
  );
  const [state, setState] = useState<IntentDraftState>({
    title: '',
    prompt: '',
    scope: null,
    composedGrid: null,
    policyScope: null,
    skipStageIds: null,
    aidlcSettings: null,
  });
  const seededRef = useRef(false);
  // Sticky, PER DOCUMENT: has this draft ever had a per-intent setting? A
  // release that authors none never puts a key in the map, so this stays false
  // and the save body omits `aidlcSettings` entirely — which is the request
  // every pre-2.11 draft already sends, byte for byte. It latches on the first
  // key seen from any source (the seed, this member, a peer) so clearing the
  // LAST override still sends `null` and still clears the stored one.
  //
  // Keyed by the document because a save OUTLIVES it: the revision read is
  // awaited before the payload is taken, so a retiring draft's save can read
  // this after the page has moved to another draft. A single flag would then
  // answer for the document now on screen and drop the retiring document's
  // settings — or its explicit `null` — from its own final PATCH.
  const hadSettingsRef = useRef(new WeakMap<Y.Doc, boolean>());
  const [hydratedDoc, setHydratedDoc] = useState<Y.Doc | null>(null);

  useEffect(() => {
    if (!doc) return;
    seededRef.current = false;
    const titleText = doc.getText('title');
    const promptText = doc.getText('prompt');
    const config = doc.getMap('config');
    const settings = doc.getMap(AIDLC_SETTINGS_MAP);
    const update = () => {
      const aidlcSettings = readAidlcSettings(doc);
      if (aidlcSettings) hadSettingsRef.current.set(doc, true);
      setState({
        title: titleText.toString(),
        prompt: promptText.toString(),
        ...readConfig(config),
        aidlcSettings,
      });
    };
    titleText.observe(update);
    promptText.observe(update);
    config.observe(update);
    settings.observe(update);
    update();
    return () => {
      titleText.unobserve(update);
      promptText.unobserve(update);
      config.unobserve(update);
      settings.unobserve(update);
    };
  }, [doc]);

  // Hydrate the CRDT from the persisted intent — ONLY when the doc is still
  // empty, so peers' live edits are never overwritten by a stale row.
  const initFromIntent = useCallback(
    (intent: Intent) => {
      if (!doc || !synced || seededRef.current) return;
      seededRef.current = true;
      seedYjsDocumentIfEmpty(doc, (seed) => {
        if (intent.title) seed.getText('title').insert(0, intent.title);
        if (intent.prompt) seed.getText('prompt').insert(0, intent.prompt);
        const config = seed.getMap('config');
        if (intent.scope) config.set('scope', intent.scope);
        if (intent.composedGrid) {
          config.set('composedGrid', JSON.stringify(intent.composedGrid));
          if (intent.policyScope) config.set('policyScope', intent.policyScope);
        }
        if (intent.skipStageIds?.length) {
          config.set('skipStageIds', JSON.stringify(intent.skipStageIds));
        }
        // Seeded INSIDE the empty-document seed, exactly like `scope`. Hydrating
        // out of band would make a mount a local edit: the observer would bump
        // the revision and the autosave would write a draft nobody touched.
        if (intent.aidlcSettings) {
          const seeded = seed.getMap<AidlcSettingValue>(AIDLC_SETTINGS_MAP);
          for (const key of AIDLC_SETTING_KEYS) {
            const value = intent.aidlcSettings[key];
            if (value !== undefined && value !== null) seeded.set(key, value);
          }
        }
      });
      setHydratedDoc(doc);
    },
    [doc, synced],
  );

  const setYText = useCallback(
    (name: 'title' | 'prompt', text: string, cursorPos?: number) => {
      if (!doc) return;
      const yText = doc.getText(name);
      const current = yText.toString();
      if (current === text) return;
      const diff = simpleDiffStringWithCursor(current, text, cursorPos ?? text.length);
      doc.transact(() => {
        if (diff.remove > 0) yText.delete(diff.index, diff.remove);
        if (diff.insert) yText.insert(diff.index, diff.insert);
      });
    },
    [doc],
  );

  const setTitle = useCallback(
    (text: string, cursorPos?: number) => setYText('title', text, cursorPos),
    [setYText],
  );
  const setPrompt = useCallback(
    (text: string, cursorPos?: number) => setYText('prompt', text, cursorPos),
    [setYText],
  );

  // Selection state — last-writer-wins atomic replace per key (the same
  // pattern as useCollaborativeStructuredAnswer's selections map).
  const setScope = useCallback(
    (scope: string) => {
      doc?.getMap('config').set('scope', scope);
    },
    [doc],
  );
  // The grid and the scope whose policy it keeps are set TOGETHER, in one
  // transaction: a grid without its base scope resolves no policy and no
  // settings at all, so a peer must never observe that intermediate state.
  const setComposedGrid = useCallback(
    (grid: Record<string, 'EXECUTE' | 'SKIP'> | null, policyScope: string | null = null) => {
      if (!doc) return;
      const config = doc.getMap('config');
      doc.transact(() => {
        if (grid && Object.keys(grid).length) {
          config.set('composedGrid', JSON.stringify(grid));
          if (policyScope) config.set('policyScope', policyScope);
          // The grid absorbs redundant overlay skips (mirrors the server's
          // pruneSkipsForGrid): a skip of a stage the grid already excludes
          // would fail plan validation on every later recompute.
          const skips = parseJson<string[]>(config.get('skipStageIds'));
          if (skips?.length) {
            const pruned = skips.filter((id) => grid[id] === 'EXECUTE');
            if (pruned.length !== skips.length) {
              if (pruned.length) config.set('skipStageIds', JSON.stringify(pruned));
              else config.delete('skipStageIds');
            }
          }
        } else {
          config.delete('composedGrid');
          config.delete('policyScope');
        }
      });
    },
    [doc],
  );
  // Choose ONE setting, or follow the scope default again with `null`.
  // Synchronous and local, exactly like `setScope`: persistence is the
  // autosave's business and its failure already has a draft-level surface
  // shared with the title, the prompt and the scope. There is no pending state
  // and no per-setting promise, so there is no second operation for Start to
  // await — the existing `flushDraft` barrier covers it.
  const setAidlcSetting = useCallback(
    (key: string, value: AidlcSettingValue | null) => {
      if (!doc) return;
      const settings = doc.getMap<AidlcSettingValue>(AIDLC_SETTINGS_MAP);
      if (value === null) {
        if (settings.has(key)) settings.delete(key);
        return;
      }
      if (settings.get(key) !== value) settings.set(key, value);
    },
    [doc],
  );

  // Replace the whole override map in ONE transaction, writing only the keys
  // that actually differ so a no-op leaves the document — and therefore the
  // autosave — untouched. Used to prune the settings a new selection no longer
  // authors, and by the compose step to apply a proposal.
  const setAidlcSettings = useCallback(
    (next: Record<string, AidlcSettingValue> | null) => {
      if (!doc) return;
      const settings = doc.getMap<AidlcSettingValue>(AIDLC_SETTINGS_MAP);
      const changed = AIDLC_SETTING_KEYS.filter((key) => {
        const value = next?.[key];
        return value === undefined ? settings.has(key) : settings.get(key) !== value;
      });
      if (changed.length === 0) return;
      doc.transact(() => {
        for (const key of changed) {
          const value = next?.[key];
          if (value === undefined) settings.delete(key);
          else settings.set(key, value);
        }
      });
    },
    [doc],
  );

  // Drop the overrides the EFFECTIVE selection does not author, through the
  // shared rule the server runs on the same payload. Returns the keys it
  // withdrew so the page can name them; a selection that authors the same
  // settings changes nothing and writes nothing.
  const pruneAidlcSettings = useCallback(
    (authored: Record<string, AidlcSettingValue> | null | undefined) => {
      if (!doc) return [];
      const current = readAidlcSettings(doc);
      if (!current) return [];
      const { value, dropped } = normalizeAidlcSettings({ settings: current, authored });
      setAidlcSettings(value);
      return dropped;
    },
    [doc, setAidlcSettings],
  );

  // Accept a composed plan: the scope, the grid, the base scope its policy
  // comes from and the settings it proposed, in ONE local transaction. There is
  // nothing asynchronous to inspect and nothing partial to recover from — the
  // card is Applied when this commits, and the whole selection reaches the
  // server in one body under one CAS, so there is no ordering between
  // "persist the selection" and "record the settings".
  const applyComposedSelection = useCallback(
    ({
      scope,
      composedGrid = null,
      policyScope = null,
      aidlcSettings = null,
    }: {
      scope: string;
      composedGrid?: Record<string, 'EXECUTE' | 'SKIP'> | null;
      policyScope?: string | null;
      aidlcSettings?: Record<string, AidlcSettingValue> | null;
    }) => {
      if (!doc) return;
      const config = doc.getMap('config');
      const settings = doc.getMap<AidlcSettingValue>(AIDLC_SETTINGS_MAP);
      doc.transact(() => {
        config.set('scope', scope);
        if (composedGrid && Object.keys(composedGrid).length) {
          config.set('composedGrid', JSON.stringify(composedGrid));
          if (policyScope) config.set('policyScope', policyScope);
          else config.delete('policyScope');
          // The grid does not replace the per-intent skip overlay, so the
          // overlay is PRUNED against it rather than dropped — exactly what
          // `setComposedGrid` does, and the mirror of the server's
          // `pruneSkipsForGrid`. Dropping it made a stage the team had
          // excluded (an API-created deselection, or a gate-time skip) start
          // running again the moment a custom plan was accepted.
          const skips = parseJson<string[]>(config.get('skipStageIds'));
          if (skips?.length) {
            const pruned = skips.filter((id) => composedGrid[id] === 'EXECUTE');
            if (pruned.length !== skips.length) {
              if (pruned.length) config.set('skipStageIds', JSON.stringify(pruned));
              else config.delete('skipStageIds');
            }
          }
        } else {
          config.delete('composedGrid');
          config.delete('policyScope');
          // A proposal that MATCHES a stock scope replaces the whole selection
          // with that scope, so an overlay the member built on the selection
          // they just replaced goes back to the scope's own stage set.
          config.delete('skipStageIds');
        }
        for (const key of AIDLC_SETTING_KEYS) {
          const value = aidlcSettings?.[key];
          if (value === undefined) settings.delete(key);
          else settings.set(key, value);
        }
      });
    },
    [doc],
  );

  const setSkipStageIds = useCallback(
    (ids: string[] | null) => {
      if (!doc) return;
      const config = doc.getMap('config');
      if (ids?.length) config.set('skipStageIds', JSON.stringify(ids));
      else config.delete('skipStageIds');
    },
    [doc],
  );

  // Debounced PATCH persistence: the backend re-validates everything (scope,
  // grid, skips) against the pinned workflow; failures remain dirty and retry.
  const getSaveData = useCallback(() => {
    if (!doc || !synced || !intentId || !seededRef.current) return null;
    const config = doc.getMap('config');
    const cfg = readConfig(config);
    return {
      title: doc.getText('title').toString().trim() || null,
      prompt: doc.getText('prompt').toString().trim() || null,
      ...(cfg.scope ? { scope: cfg.scope } : {}),
      composedGrid: cfg.composedGrid,
      // Only ever sent WITH a grid, and only when the selection actually has
      // one: the API refuses a base scope for a selection that names its scope
      // directly. A release that authors no setting has no base to resolve, so
      // it ignores the field on save instead of refusing it. Clearing the grid
      // clears the stored base in the same write.
      ...(cfg.composedGrid && cfg.policyScope ? { policyScope: cfg.policyScope } : {}),
      skipStageIds: cfg.skipStageIds,
      // Sent WITH the selection, never alone: the API validates the settings
      // against the selection in the same body and refuses a body that carries
      // one without the other. OMITTED for a draft that has never had a
      // setting, so an unpinned, 2.3.3, 2.8.2 or 2.9.0 draft keeps sending
      // exactly the body it sent before these settings existed.
      ...(hadSettingsRef.current.get(doc) ? { aidlcSettings: readAidlcSettings(doc) } : {}),
    };
  }, [doc, synced, intentId]);

  const save = useCallback(async () => {
    if (!intentId) return;
    return saveCollaborativeProjection({
      readVersion: () => intentsService.draftEditState(projectId, intentId),
      flush: flushDocument,
      readData: () => {
        const data = getSaveData();
        if (!data) throw new Error('Draft is not ready to save');
        return data;
      },
      write: async (data, version) => {
        await intentsService.update(projectId, intentId, {
          ...data,
          ifDraftRevision: version.draftRevision,
        });
      },
    });
  }, [projectId, intentId, flushDocument, getSaveData]);

  const { flushLatest } = useAutoSave(getSaveData, save, [localRevision], {
    enabled: synced && !!intentId,
    skipInitial: true,
    resetKey: doc,
    beforeDisconnect,
  });

  return {
    ...state,
    synced,
    hydrated: hydratedDoc === doc,
    awareness,
    remoteUsers,
    titleText: doc.getText('title'),
    promptText: doc.getText('prompt'),
    setCursor,
    initFromIntent,
    setTitle,
    setPrompt,
    setScope,
    setComposedGrid,
    setSkipStageIds,
    setAidlcSetting,
    setAidlcSettings,
    pruneAidlcSettings,
    applyComposedSelection,
    // Awaitable flush so Start can guarantee the last edits are persisted
    // before launching (the launch reads the META row, not the Yjs doc).
    flushDraft: flushLatest,
  };
}
