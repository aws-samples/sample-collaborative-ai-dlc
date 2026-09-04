import { useEffect, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';
import { generateColor } from '../utils/colors';
import { seedYjsDocumentIfEmpty } from '../lib/yjsSeed';
import type { StructuredAnswer, QuestionAnswer } from '../services/questions';

interface StructuredAnswerState {
  answers: QuestionAnswer[];
  contributors: string[];
}

interface InceptionState {
  description: string;
  answers: Record<string, StructuredAnswerState>;
  status: 'drafting' | 'running' | 'waiting' | 'completed';
  startedBy?: string;
}

interface AutoSaveCallbacks {
  /** Persist the inception description to the backend sprint record */
  onSaveDescription?: (description: string) => Promise<void>;
  /** Persist a question-answer draft to the backend questions table */
  onSaveDraft?: (questionId: string, draftAnswer: StructuredAnswer) => Promise<void>;
}

export function useCollaborativeInception(
  projectId: string,
  _userId: string,
  userName: string,
  autoSave?: AutoSaveCallbacks,
) {
  const { doc, synced, remoteUsers, setCursor } = useYjsDocument(
    `inception-${projectId}`,
    userName,
    generateColor(userName),
  );
  const [state, setState] = useState<InceptionState>({
    description: '',
    answers: {},
    status: 'drafting',
  });

  // Sync Yjs state to React state
  useEffect(() => {
    if (!doc) return;

    const descriptionText = doc.getText('description');
    const answersMap = doc.getMap('answers');
    const metaMap = doc.getMap('meta');

    const updateState = () => {
      const answers: Record<string, StructuredAnswerState> = {};
      answersMap.forEach((value, key) => {
        const answerDoc = value as Y.Map<any>;
        const selectionsMap = answerDoc.get('selections') as Y.Map<Y.Array<number>> | undefined;
        const freeTextsMap = answerDoc.get('freeTexts') as Y.Map<Y.Text> | undefined;
        const contribArr = answerDoc.get('contributors') as Y.Array<string> | undefined;

        // Build QuestionAnswer array from selections + freeTexts
        const questionAnswers: QuestionAnswer[] = [];
        const maxIndex = Math.max(
          selectionsMap ? Math.max(...Array.from(selectionsMap.keys()).map(Number), -1) : -1,
          freeTextsMap ? Math.max(...Array.from(freeTextsMap.keys()).map(Number), -1) : -1,
        );

        for (let i = 0; i <= maxIndex; i++) {
          const sel = selectionsMap?.get(String(i)) as Y.Array<number> | undefined;
          const ft = freeTextsMap?.get(String(i)) as Y.Text | undefined;
          questionAnswers.push({
            selectedOptions: sel ? sel.toArray() : [],
            freeText: ft ? ft.toString() : undefined,
          });
        }

        answers[key] = {
          answers: questionAnswers,
          contributors: contribArr ? contribArr.toArray() : [],
        };
      });

      setState({
        description: descriptionText.toString(),
        answers,
        status: (metaMap.get('status') as InceptionState['status']) || 'drafting',
        startedBy: metaMap.get('startedBy') as string | undefined,
      });
    };

    descriptionText.observe(updateState);
    answersMap.observeDeep(updateState);
    metaMap.observe(updateState);
    updateState();

    return () => {
      descriptionText.unobserve(updateState);
      answersMap.unobserveDeep(updateState);
      metaMap.unobserve(updateState);
    };
  }, [doc]);

  /**
   * Seed the description Y.Text from a persisted value (e.g. Neptune).
   * Only inserts if the Y.Text is currently empty, so it won't overwrite
   * content that arrived from other Yjs peers.
   */
  const initDescription = useCallback(
    (text: string) => {
      if (!doc) return;
      seedYjsDocumentIfEmpty(doc, (seed) => {
        if (text) seed.getText('description').insert(0, text);
      });
    },
    [doc],
  );

  /**
   * Diff-based description setter. Computes minimal edits so remote cursors
   * are preserved and concurrent edits merge correctly via CRDT.
   */
  const setDescription = useCallback(
    (text: string, cursorPos?: number) => {
      if (!doc) return;
      const descriptionText = doc.getText('description');
      const currentValue = descriptionText.toString();
      if (currentValue === text) return;

      const cursor = cursorPos ?? text.length;
      const diff = simpleDiffStringWithCursor(currentValue, text, cursor);
      doc.transact(() => {
        if (diff.remove > 0) descriptionText.delete(diff.index, diff.remove);
        if (diff.insert) descriptionText.insert(diff.index, diff.insert);
      });
    },
    [doc],
  );

  /** Ensure an answer doc exists for a given questionId */
  const ensureAnswerDoc = useCallback(
    (questionId: string) => {
      if (!doc) return null;
      const answersMap = doc.getMap('answers');
      let answerDoc = answersMap.get(questionId) as Y.Map<any> | undefined;
      if (!answerDoc) {
        answerDoc = new Y.Map();
        answerDoc.set('selections', new Y.Map());
        answerDoc.set('freeTexts', new Y.Map());
        answerDoc.set('contributors', new Y.Array());
        answersMap.set(questionId, answerDoc);
      }
      return answerDoc;
    },
    [doc],
  );

  /**
   * Set selected option indices for a sub-question within a question.
   */
  const updateSelection = useCallback(
    (questionId: string, questionIndex: number, optionIndices: number[]) => {
      if (!doc) return;
      doc.transact(() => {
        const answerDoc = ensureAnswerDoc(questionId);
        if (!answerDoc) return;
        const selectionsMap = answerDoc.get('selections') as Y.Map<Y.Array<number>>;
        const arr = new Y.Array<number>();
        arr.insert(0, optionIndices);
        selectionsMap.set(String(questionIndex), arr);

        const contributors = answerDoc.get('contributors') as Y.Array<string>;
        if (!contributors.toArray().includes(userName)) {
          contributors.push([userName]);
        }
      });
    },
    [doc, userName, ensureAnswerDoc],
  );

  /**
   * Diff-based free text updater for a sub-question.
   */
  const updateFreeText = useCallback(
    (questionId: string, questionIndex: number, text: string, cursorPos?: number) => {
      if (!doc) return;
      doc.transact(() => {
        const answerDoc = ensureAnswerDoc(questionId);
        if (!answerDoc) return;
        const freeTextsMap = answerDoc.get('freeTexts') as Y.Map<Y.Text>;
        const key = String(questionIndex);
        let textDoc = freeTextsMap.get(key) as Y.Text | undefined;
        if (!textDoc) {
          textDoc = new Y.Text();
          freeTextsMap.set(key, textDoc);
        }
        const currentValue = textDoc.toString();
        if (currentValue !== text) {
          const cursor = cursorPos ?? text.length;
          const diff = simpleDiffStringWithCursor(currentValue, text, cursor);
          if (diff.remove > 0) textDoc.delete(diff.index, diff.remove);
          if (diff.insert) textDoc.insert(diff.index, diff.insert);
        }

        const contributors = answerDoc.get('contributors') as Y.Array<string>;
        if (!contributors.toArray().includes(userName)) {
          contributors.push([userName]);
        }
      });
    },
    [doc, userName, ensureAnswerDoc],
  );

  const setStatus = useCallback(
    (status: InceptionState['status'], startedBy?: string) => {
      if (!doc) return;
      const metaMap = doc.getMap('meta');
      doc.transact(() => {
        metaMap.set('status', status);
        if (startedBy) metaMap.set('startedBy', startedBy);
      });
    },
    [doc],
  );

  const reset = useCallback(() => {
    if (!doc) return;
    const metaMap = doc.getMap('meta');
    doc.transact(() => {
      metaMap.delete('status');
      metaMap.delete('startedBy');
    });
  }, [doc]);

  /**
   * Get the structured answer state for a question.
   */
  const getAnswer = useCallback(
    (questionId: string): StructuredAnswerState => {
      return state.answers[questionId] || { answers: [], contributors: [] };
    },
    [state.answers],
  );

  /**
   * Snapshot a question's answer state as a StructuredAnswer for submission.
   */
  const getStructuredAnswer = useCallback(
    (questionId: string, questionCount: number): StructuredAnswer => {
      const answerState = state.answers[questionId];
      if (!answerState) {
        return { answers: Array.from({ length: questionCount }, () => ({ selectedOptions: [] })) };
      }
      const answers: QuestionAnswer[] = [];
      for (let i = 0; i < questionCount; i++) {
        answers.push(answerState.answers[i] || { selectedOptions: [] });
      }
      return { answers };
    },
    [state.answers],
  );

  // ── Auto-save description to backend ──
  const getDescriptionData = useCallback(() => {
    if (!doc || !synced) return null;
    const desc = doc.getText('description').toString();
    if (!desc) return null;
    return { description: desc };
  }, [doc, synced]);

  const saveDescription = useCallback(
    async (data: Record<string, string>) => {
      if (autoSave?.onSaveDescription && data.description) {
        await autoSave.onSaveDescription(data.description);
      }
    },
    [autoSave],
  );

  useAutoSave(getDescriptionData, saveDescription, [state.description], {
    enabled: synced && !!autoSave?.onSaveDescription,
  });

  // ── Auto-save answer drafts to backend ──
  const answersKey = JSON.stringify(state.answers);

  const getAnswersData = useCallback(() => {
    if (!doc || !synced || !autoSave?.onSaveDraft) return null;
    const data: Record<string, StructuredAnswer> = {};
    for (const [questionId, answerState] of Object.entries(state.answers)) {
      const hasData = answerState.answers.some(
        (a) => a.selectedOptions.length > 0 || (a.freeText && a.freeText.length > 0),
      );
      if (hasData) {
        data[questionId] = { answers: answerState.answers };
      }
    }
    if (Object.keys(data).length === 0) return null;
    return data;
  }, [doc, synced, autoSave, state.answers]);

  const saveAnswerDrafts = useCallback(
    async (data: Record<string, StructuredAnswer>) => {
      if (!autoSave?.onSaveDraft) return;
      await Promise.all(
        Object.entries(data).map(([questionId, draftAnswer]) =>
          autoSave.onSaveDraft!(questionId, draftAnswer),
        ),
      );
    },
    [autoSave],
  );

  useAutoSave(getAnswersData, saveAnswerDrafts, [answersKey], {
    enabled: synced && !!autoSave?.onSaveDraft,
  });

  return {
    ...state,
    synced,
    remoteUsers,
    setDescription,
    initDescription,
    updateSelection,
    updateFreeText,
    getAnswer,
    getStructuredAnswer,
    setStatus,
    reset,
    setCursor,
  };
}
