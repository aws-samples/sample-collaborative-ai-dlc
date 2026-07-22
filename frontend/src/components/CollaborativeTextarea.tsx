import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultKeymap } from '@codemirror/commands';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { Pilcrow } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  id?: string;
  'aria-label'?: string;
  /**
   * The shared type is the editor's source of truth. When supplied, edits are
   * applied as CodeMirror transactions directly to Y.Text instead of diffing a
   * controlled React value.
   */
  yText?: Y.Text;
  awareness?: Awareness | null;
  value?: string;
  onChange?: (value: string, cursorPos: number) => void;
  onCursorChange?: (index: number, length: number) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  rows?: number;
  singleLine?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minWidth: '0',
    width: '100%',
    backgroundColor: 'transparent',
    color: 'inherit',
    font: 'inherit',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    height: '100%',
    overflow: 'auto',
    scrollbarGutter: 'stable',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
  },
  '.cm-content': {
    minHeight: '100%',
    padding: '0',
    caretColor: 'currentColor',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'currentColor',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'color-mix(in oklab, var(--ring) 24%, transparent)',
  },
  '.cm-placeholder': {
    color: 'var(--muted-foreground)',
    opacity: '1',
  },
  '.cm-ySelectionCaret': {
    borderLeftWidth: '2px',
  },
  '.cm-ySelectionInfo': {
    top: '1.15em',
    borderRadius: '2px',
    padding: '1px 4px',
    fontFamily: 'inherit',
    fontSize: '10px',
    opacity: '1',
  },
});

const singleLineKeymap = Prec.highest(
  keymap.of([
    { key: 'Enter', run: () => true },
    { key: 'Shift-Enter', run: () => true },
    { key: 'Mod-Enter', run: () => true },
  ]),
);

interface RemotePosition {
  clientId: number;
  name: string;
  color: string;
  index: number;
  line: number;
}

/**
 * Plain-text collaborative editor backed directly by Y.Text.
 *
 * The optional controlled props are only used by the non-collaborative
 * fallback. A shared editor never sends whole strings back through React.
 */
export function CollaborativeTextarea({
  id,
  'aria-label': ariaLabel,
  yText,
  awareness,
  value = '',
  onChange,
  onCursorChange,
  disabled = false,
  placeholder,
  className,
  rows = 4,
  singleLine = false,
  onFocus,
  onBlur,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onFocusRef = useRef(onFocus);
  const onBlurRef = useRef(onBlur);
  const disabledRef = useRef(disabled);
  const editable = useMemo(() => new Compartment(), []);
  const [focused, setFocused] = useState(false);
  const [localLine, setLocalLine] = useState(1);
  const [remotePositions, setRemotePositions] = useState<RemotePosition[]>([]);

  onFocusRef.current = onFocus;
  onBlurRef.current = onBlur;
  disabledRef.current = disabled;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !yText || !awareness) return;
    const undoManager = new Y.UndoManager(yText);
    let view: EditorView;

    const updatePositions = () => {
      const positions: RemotePosition[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.doc.clientID || !state.cursor?.head) return;
        const absolute = Y.createAbsolutePositionFromRelativePosition(
          state.cursor.head,
          awareness.doc,
        );
        if (!absolute || absolute.type !== yText) return;
        const user = state.user ?? {};
        positions.push({
          clientId,
          name: user.name || 'Anonymous',
          color: user.color || '#64748b',
          index: absolute.index,
          line: view ? view.state.doc.lineAt(absolute.index).number : 1,
        });
      });
      setRemotePositions(positions);
    };

    const extensions = [
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      editorTheme,
      editable.of([
        EditorState.readOnly.of(disabledRef.current),
        EditorView.editable.of(!disabledRef.current),
      ]),
      keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
      yCollab(yText, awareness, { undoManager }),
      EditorView.contentAttributes.of({
        ...(id ? { id } : {}),
        role: 'textbox',
        'aria-multiline': singleLine ? 'false' : 'true',
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      }),
      EditorView.domEventHandlers({
        focus: (_event, editor) => {
          setFocused(true);
          setLocalLine(editor.state.doc.lineAt(editor.state.selection.main.head).number);
          onFocusRef.current?.();
          // Force the awareness plugin to publish this editor's relative
          // selection when focus moves between fields in the same document.
          editor.dispatch({});
          return false;
        },
        blur: () => {
          setFocused(false);
          awareness.setLocalStateField('cursor', null);
          onBlurRef.current?.();
          return false;
        },
        beforeinput: (event) => {
          if (singleLine && event.inputType === 'insertParagraph') {
            event.preventDefault();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged || update.focusChanged) {
          setLocalLine(update.state.doc.lineAt(update.state.selection.main.head).number);
          updatePositions();
        }
      }),
    ];

    if (placeholder) extensions.push(placeholderExtension(placeholder));
    if (singleLine) {
      extensions.push(singleLineKeymap);
      extensions.push(EditorView.clipboardInputFilter.of((text) => text.replaceAll(/\r?\n/g, ' ')));
    }

    view = new EditorView({
      state: EditorState.create({
        doc: yText.toString(),
        extensions,
      }),
      parent: host,
    });
    viewRef.current = view;
    awareness.on('change', updatePositions);
    updatePositions();

    return () => {
      if (view.hasFocus) awareness.setLocalStateField('cursor', null);
      awareness.off('change', updatePositions);
      view.destroy();
      undoManager.destroy();
      viewRef.current = null;
      setRemotePositions([]);
    };
  }, [ariaLabel, awareness, editable, id, placeholder, singleLine, yText]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editable.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled, editable]);

  const height = singleLine ? '2.25rem' : `${Math.max(rows, 1) * 1.25 + 1}rem`;
  const shared = !!yText && !!awareness;
  const contributionTools = !singleLine && rows >= 4;
  const nearbyUsers = focused
    ? remotePositions.filter((position) => position.line === localLine)
    : [];

  const startNewParagraph = useCallback(() => {
    const view = viewRef.current;
    if (!view || disabledRef.current) return;
    const end = view.state.doc.length;
    view.focus();
    view.dispatch({
      changes: { from: end, insert: '\n\n' },
      selection: { anchor: end + 1 },
      scrollIntoView: true,
      userEvent: 'input.new-paragraph',
    });
  }, []);

  const revealRemoteCursor = useCallback((position: RemotePosition) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: EditorView.scrollIntoView(position.index, { y: 'center' }) });
  }, []);

  if (!shared) {
    if (singleLine) {
      return (
        <input
          id={id}
          aria-label={ariaLabel}
          value={value}
          onChange={(event) =>
            onChange?.(event.target.value, event.target.selectionStart ?? event.target.value.length)
          }
          onSelect={(event) => {
            const input = event.currentTarget;
            onCursorChange?.(
              input.selectionStart ?? 0,
              (input.selectionEnd ?? 0) - (input.selectionStart ?? 0),
            );
          }}
          onFocus={onFocus}
          onBlur={onBlur}
          disabled={disabled}
          placeholder={placeholder}
          className={cn('w-full', className)}
        />
      );
    }
    return (
      <textarea
        id={id}
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange?.(event.target.value, event.target.selectionStart)}
        onSelect={(event) => {
          const textarea = event.currentTarget;
          onCursorChange?.(
            textarea.selectionStart,
            textarea.selectionEnd - textarea.selectionStart,
          );
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        disabled={disabled}
        placeholder={placeholder}
        rows={rows}
        className={cn('w-full', className)}
      />
    );
  }

  return (
    <div className="w-full">
      <div
        ref={hostRef}
        data-collaborative-editor
        className={cn(
          'w-full overflow-hidden focus-within:border-ring focus-within:outline-none',
          disabled && 'cursor-not-allowed opacity-50',
          className,
        )}
        style={{ height }}
      />
      {contributionTools && (
        <div className="mt-1 flex h-7 min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {nearbyUsers.length > 0 && (
              <span className="shrink-0 font-medium text-amber-600 dark:text-amber-400">
                {nearbyUsers.map((user) => user.name).join(', ')} on this line
              </span>
            )}
            {remotePositions.map((position) => (
              <button
                key={position.clientId}
                type="button"
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 hover:bg-muted hover:text-foreground"
                onClick={() => revealRemoteCursor(position)}
                title={`Show ${position.name}'s cursor`}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: position.color }}
                />
                {position.name} · L{position.line}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded border bg-background px-2 font-medium text-foreground shadow-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            onClick={startNewParagraph}
            disabled={disabled}
            title="Start a separate contribution at the end"
          >
            <Pilcrow className="h-3 w-3" />
            New paragraph
          </button>
        </div>
      )}
    </div>
  );
}
