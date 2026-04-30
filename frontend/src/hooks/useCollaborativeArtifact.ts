import { useEffect, useState, useCallback, useMemo } from 'react';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import { useYjsDocument } from './useYjsDocument';
import { useAutoSave } from './useAutoSave';

/**
 * Generic hook for collaborative editing of any artifact.
 * Creates a Yjs document keyed as `{artifactType}-{sprintId}-{artifactId}`.
 * Each field is stored as a Y.Text for conflict-free concurrent editing.
 *
 * Uses diff-based Y.Text updates (not delete-all/insert-all) so remote
 * cursors are preserved and concurrent edits merge correctly.
 *
 * @param isEditing  When true, connects to Yjs. When false, no WebSocket connection.
 * @param onAutoSave Optional callback invoked on 2 s debounce + unmount + beforeunload.
 */
export function useCollaborativeArtifact<T extends Record<string, string>>(
  artifactType: string,
  sprintId: string,
  artifactId: string,
  fields: (keyof T)[],
  userName: string,
  isEditing: boolean = false,
  onAutoSave?: (values: T) => Promise<void>,
) {
  const docId = isEditing ? `${artifactType}-${sprintId}-${artifactId}` : null;
  const { doc, synced, remoteUsers, setCursor } = useYjsDocument(docId, userName);
  const [values, setValues] = useState<T>({} as T);

  // Stabilize fields reference so it doesn't cause effect re-runs
  const fieldsKey = (fields as string[]).join(',');
  const stableFields = useMemo(() => fields, [fieldsKey]);

  useEffect(() => {
    if (!doc) return;

    const texts = stableFields.map(f => doc.getText(f as string));

    const update = () => {
      const v: Record<string, string> = {};
      stableFields.forEach((f, i) => { v[f as string] = texts[i].toString(); });
      setValues(v as T);
    };

    texts.forEach(t => t.observe(update));
    update();

    return () => { texts.forEach(t => t.unobserve(update)); };
  }, [doc, stableFields]);

  /**
   * Diff-based field setter. Computes the minimal edit between the current
   * Y.Text content and `value`, preserving remote cursors and enabling
   * true character-level CRDT merges.
   *
   * @param field     The field name (Y.Text key)
   * @param value     The new string value
   * @param cursorPos The local cursor position (textarea.selectionStart)
   *                  for optimal diff disambiguation. Falls back to end-of-string.
   */
  const setField = useCallback((field: keyof T, value: string, cursorPos?: number) => {
    if (!doc) return;
    const text = doc.getText(field as string);
    const currentValue = text.toString();
    if (currentValue === value) return; // no-op

    const cursor = cursorPos ?? value.length;
    const diff = simpleDiffStringWithCursor(currentValue, value, cursor);
    doc.transact(() => {
      if (diff.remove > 0) text.delete(diff.index, diff.remove);
      if (diff.insert) text.insert(diff.index, diff.insert);
    });
  }, [doc]);

  const initFields = useCallback((initial: Partial<T>) => {
    if (!doc) return;
    doc.transact(() => {
      Object.entries(initial).forEach(([key, val]) => {
        const text = doc.getText(key);
        if (text.length === 0 && val) {
          text.insert(0, val as string);
        }
      });
    });
  }, [doc]);

  // ── Auto-save: persist Yjs state to backend on debounce + unmount + unload ──
  const getAutoSaveData = useCallback(() => {
    if (!doc || !synced) return null;
    const v: Record<string, string> = {};
    stableFields.forEach(f => {
      v[f as string] = doc.getText(f as string).toString();
    });
    // Return null if all fields are empty (nothing to save)
    if (Object.values(v).every(s => !s)) return null;
    return v;
  }, [doc, synced, stableFields]);

  const autoSaveHandler = useCallback(async (data: Record<string, string>) => {
    if (onAutoSave) {
      await onAutoSave(data as T);
    }
  }, [onAutoSave]);

  // Serialize values to a stable string so useAutoSave can detect changes
  const valuesKey = stableFields.map(f => values[f] ?? '').join('\x00');

  useAutoSave(getAutoSaveData, autoSaveHandler, [valuesKey], {
    enabled: isEditing && synced && !!onAutoSave,
  });

  return { values, setField, initFields, synced, remoteUsers, setCursor, doc };
}
