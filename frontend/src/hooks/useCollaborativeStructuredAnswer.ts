import { useEffect, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';
import { generateColor } from '../utils/colors';
import { seedYjsDocumentIfEmpty } from '../lib/yjsSeed';
import type { RealtimeScopeTarget } from '../lib/realtimeToken';
import type { StructuredAnswer, QuestionAnswer } from '../services/questions';

// The collaboration scope a structured answer is keyed under. v1 sprints use
// `{ kind: 'sprint', id }`; v2 intents use `{ kind: 'intent', id, projectId }`
// (the realtime-token endpoint for an intent is project-scoped). The scope
// decides both the Yjs doc-name prefix and the token target.
export type CollabScope =
  | { kind: 'sprint'; id: string }
  | { kind: 'intent'; id: string; projectId: string };

const docPrefixFor = (scope: CollabScope, questionId: string): string =>
  scope.kind === 'intent' ? `intent-sq-${scope.id}-${questionId}` : `sq-${scope.id}-${questionId}`;

const scopeTargetFor = (scope: CollabScope): RealtimeScopeTarget =>
  scope.kind === 'intent'
    ? { intentId: scope.id, projectId: scope.projectId }
    : { sprintId: scope.id };

/**
 * Collaborative hook for structured question answering.
 *
 * Yjs document structure:
 *   Y.Map "selections"  – key: sub-question index (string), value: Y.Array<number> (selected option indices)
 *   Y.Text "freeText:N" – one top-level shared type per sub-question
 *   Y.Map "meta"        – "contributors": Y.Array<string>
 *
 * Selections use Y.Array replaced atomically (last-writer-wins per sub-question).
 * Free text fields use Y.Text for character-level CRDT merging.
 */
export function useCollaborativeStructuredAnswer(
  scope: CollabScope,
  questionId: string,
  questionCount: number,
  userName: string,
  onAutoSave?: (draft: StructuredAnswer) => Promise<void>,
) {
  const docId = docPrefixFor(scope, questionId);
  const { doc, synced, awareness, remoteUsers, setCursor } = useYjsDocument(
    docId,
    userName,
    generateColor(userName),
    scopeTargetFor(scope),
  );

  const [selections, setSelections] = useState<Map<number, number[]>>(new Map());
  const [freeTexts, setFreeTexts] = useState<Map<number, string>>(new Map());
  const [contributors, setContributors] = useState<string[]>([]);

  // Observe Yjs state and sync to React state
  useEffect(() => {
    if (!doc) return;

    const selectionsMap = doc.getMap('selections');
    const metaMap = doc.getMap('meta');
    const textDocs = Array.from({ length: questionCount }, (_, index) =>
      doc.getText(`freeText:${index}`),
    );

    const updateState = () => {
      // Read selections
      const newSelections = new Map<number, number[]>();
      selectionsMap.forEach((value, key) => {
        const arr = value as Y.Array<number>;
        newSelections.set(Number(key), arr.toArray());
      });
      setSelections(newSelections);

      // Read free texts
      const newFreeTexts = new Map<number, string>();
      textDocs.forEach((text, index) => {
        if (text.length > 0) newFreeTexts.set(index, text.toString());
      });
      setFreeTexts(newFreeTexts);

      // Read contributors
      const contribArr = metaMap.get('contributors') as Y.Array<string> | undefined;
      setContributors(contribArr ? contribArr.toArray() : []);
    };

    selectionsMap.observeDeep(updateState);
    textDocs.forEach((text) => text.observe(updateState));
    metaMap.observeDeep(updateState);
    updateState();

    return () => {
      selectionsMap.unobserveDeep(updateState);
      textDocs.forEach((text) => text.unobserve(updateState));
      metaMap.unobserveDeep(updateState);
    };
  }, [doc, questionCount]);

  // Track contributor
  const addContributor = useCallback(() => {
    if (!doc) return;
    const metaMap = doc.getMap('meta');
    doc.transact(() => {
      let contribArr = metaMap.get('contributors') as Y.Array<string> | undefined;
      if (!contribArr) {
        contribArr = new Y.Array<string>();
        metaMap.set('contributors', contribArr);
      }
      if (!contribArr.toArray().includes(userName)) {
        contribArr.push([userName]);
      }
    });
  }, [doc, userName]);

  /**
   * Set selected option indices for a sub-question.
   * Replaces the entire Y.Array atomically (last-writer-wins).
   */
  const setSelection = useCallback(
    (questionIndex: number, optionIndices: number[]) => {
      if (!doc) return;
      const selectionsMap = doc.getMap('selections');
      doc.transact(() => {
        const key = String(questionIndex);
        // Replace entire array
        const arr = new Y.Array<number>();
        arr.insert(0, optionIndices);
        selectionsMap.set(key, arr);
      });
      addContributor();
    },
    [doc, addContributor],
  );

  /**
   * Diff-based free text setter for a sub-question.
   * Uses Y.Text for proper CRDT co-editing.
   */
  const setFreeText = useCallback(
    (questionIndex: number, text: string, cursorPos?: number) => {
      if (!doc) return;
      const textDoc = doc.getText(`freeText:${questionIndex}`);

      doc.transact(() => {
        const currentValue = textDoc.toString();
        if (currentValue === text) return;

        const cursor = cursorPos ?? text.length;
        const diff = simpleDiffStringWithCursor(currentValue, text, cursor);
        if (diff.remove > 0) textDoc.delete(diff.index, diff.remove);
        if (diff.insert) textDoc.insert(diff.index, diff.insert);
      });
      addContributor();
    },
    [doc, addContributor],
  );

  const getFreeText = useCallback(
    (questionIndex: number) => doc.getText(`freeText:${questionIndex}`),
    [doc],
  );

  /**
   * Initialize from a persisted draft (e.g., from Neptune/DynamoDB).
   * Only sets values if the Yjs fields are currently empty.
   */
  const initFromDraft = useCallback(
    (draft: StructuredAnswer) => {
      if (!doc) return;
      seedYjsDocumentIfEmpty(doc, (seed) => {
        const selectionsMap = seed.getMap('selections');
        draft.answers.forEach((a, i) => {
          const key = String(i);
          if (a.selectedOptions.length > 0) {
            const arr = new Y.Array<number>();
            arr.insert(0, a.selectedOptions);
            selectionsMap.set(key, arr);
          }
          if (a.freeText) seed.getText(`freeText:${i}`).insert(0, a.freeText);
        });
      });
    },
    [doc],
  );

  /**
   * Snapshot current Yjs state as a StructuredAnswer for submission.
   */
  const toStructuredAnswer = useCallback((): StructuredAnswer => {
    const answers: QuestionAnswer[] = [];
    for (let i = 0; i < questionCount; i++) {
      answers.push({
        selectedOptions: selections.get(i) || [],
        freeText: freeTexts.get(i) || undefined,
      });
    }
    return { answers };
  }, [questionCount, selections, freeTexts]);

  // ── Auto-save draft to backend ──
  const selectionsKey = JSON.stringify(Array.from(selections.entries()));
  const freeTextsKey = JSON.stringify(Array.from(freeTexts.entries()));

  const getAutoSaveData = useCallback(() => {
    if (!doc || !synced) return null;
    const answer = toStructuredAnswer();
    // Only save if there's any data
    const hasData = answer.answers.some(
      (a) => a.selectedOptions.length > 0 || (a.freeText && a.freeText.length > 0),
    );
    if (!hasData) return null;
    return answer;
  }, [doc, synced, toStructuredAnswer]);

  const autoSaveHandler = useCallback(
    async (data: StructuredAnswer) => {
      if (onAutoSave) {
        await onAutoSave(data);
      }
    },
    [onAutoSave],
  );

  useAutoSave(getAutoSaveData, autoSaveHandler, [selectionsKey, freeTextsKey], {
    enabled: synced && !!onAutoSave,
  });

  return {
    selections,
    freeTexts,
    setSelection,
    setFreeText,
    getFreeText,
    addContributor,
    synced,
    awareness,
    remoteUsers,
    setCursor,
    contributors,
    initFromDraft,
    toStructuredAnswer,
  };
}
