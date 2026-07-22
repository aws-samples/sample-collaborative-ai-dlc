import { useEffect, useState, useCallback, useRef } from 'react';
import * as Y from 'yjs';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';
import { generateColor } from '../utils/colors';
import { seedYjsDocumentIfEmpty } from '../lib/yjsSeed';
import { intentsService, type Intent } from '../services/intents';

// The collaboratively edited slice of a DRAFT intent. Yjs is the transport
// (docs evaporate ~60s after the last client leaves); the intent's META row —
// written through the debounced PATCH auto-save — is the durability. Shapes:
//   Y.Text 'title' / 'prompt'      — diff-based collaborative text
//   Y.Map  'config'                — LWW atomic-replace selection state:
//     scope: string                — scope name or composed-grid label
//     composedGrid: JSON string    — {stageId: EXECUTE|SKIP} or absent
//     skipStageIds: JSON string    — string[] or absent
export interface IntentDraftState {
  title: string;
  prompt: string;
  scope: string | null;
  composedGrid: Record<string, 'EXECUTE' | 'SKIP'> | null;
  skipStageIds: string[] | null;
}

const parseJson = <T>(raw: unknown): T | null => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const readConfig = (config: Y.Map<unknown>): Omit<IntentDraftState, 'title' | 'prompt'> => {
  const scope = config.get('scope');
  return {
    scope: typeof scope === 'string' && scope ? scope : null,
    composedGrid: parseJson<Record<string, 'EXECUTE' | 'SKIP'>>(config.get('composedGrid')),
    skipStageIds: parseJson<string[]>(config.get('skipStageIds')),
  };
};

export function useCollaborativeIntentDraft(
  projectId: string,
  intentId: string | null,
  userName: string,
) {
  const { doc, synced, awareness, remoteUsers, setCursor } = useYjsDocument(
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
    skipStageIds: null,
  });
  const seededRef = useRef(false);
  const [hydratedDoc, setHydratedDoc] = useState<Y.Doc | null>(null);

  useEffect(() => {
    if (!doc) return;
    seededRef.current = false;
    const titleText = doc.getText('title');
    const promptText = doc.getText('prompt');
    const config = doc.getMap('config');
    const update = () =>
      setState({
        title: titleText.toString(),
        prompt: promptText.toString(),
        ...readConfig(config),
      });
    titleText.observe(update);
    promptText.observe(update);
    config.observe(update);
    update();
    return () => {
      titleText.unobserve(update);
      promptText.unobserve(update);
      config.unobserve(update);
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
        }
        if (intent.skipStageIds?.length) {
          config.set('skipStageIds', JSON.stringify(intent.skipStageIds));
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
  const setComposedGrid = useCallback(
    (grid: Record<string, 'EXECUTE' | 'SKIP'> | null) => {
      if (!doc) return;
      const config = doc.getMap('config');
      doc.transact(() => {
        if (grid && Object.keys(grid).length) {
          config.set('composedGrid', JSON.stringify(grid));
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
  // grid, skips) against the pinned plan; a rejected save only logs — the next
  // valid edit saves again.
  const getSaveData = useCallback(() => {
    if (!doc || !synced || !intentId || !seededRef.current) return null;
    const config = doc.getMap('config');
    const cfg = readConfig(config);
    return {
      title: doc.getText('title').toString().trim() || null,
      prompt: doc.getText('prompt').toString().trim() || null,
      ...(cfg.scope ? { scope: cfg.scope } : {}),
      composedGrid: cfg.composedGrid,
      skipStageIds: cfg.skipStageIds,
    };
  }, [doc, synced, intentId]);

  const save = useCallback(
    async (data: NonNullable<ReturnType<typeof getSaveData>>) => {
      if (!intentId) return;
      await intentsService.update(projectId, intentId, data);
    },
    [projectId, intentId],
  );

  const { flush } = useAutoSave(
    getSaveData,
    save,
    [state.title, state.prompt, state.scope, state.composedGrid, state.skipStageIds],
    { enabled: synced && !!intentId },
  );

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
    // Awaitable flush so Start can guarantee the last edits are persisted
    // before launching (the launch reads the META row, not the Yjs doc).
    flushDraft: flush,
  };
}
