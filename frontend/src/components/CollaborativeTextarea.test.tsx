import { fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { CollaborativeTextarea } from './CollaborativeTextarea';

const rect = {
  x: 0,
  y: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect;

Object.defineProperties(Range.prototype, {
  getBoundingClientRect: { value: () => rect, configurable: true },
  getClientRects: {
    value: () => Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) }),
    configurable: true,
  },
});

const createSharedText = (initial = '', name = 'Test user', color = '#3b82f6') => {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  if (initial) text.insert(0, initial);
  const awareness = new Awareness(doc);
  awareness.setLocalStateField('user', {
    name,
    color,
    colorLight: `${color}33`,
  });
  return { doc, text, awareness };
};

describe('CollaborativeTextarea', () => {
  it('keeps the local caret anchored when a remote insertion arrives', () => {
    const shared = createSharedText('hello world');
    const wholeValueChange = vi.fn();

    const { unmount } = render(
      <CollaborativeTextarea
        yText={shared.text}
        awareness={shared.awareness}
        onChange={wholeValueChange}
        aria-label="Shared content"
        rows={3}
      />,
    );

    const editor = screen.getByRole('textbox');
    const view = EditorView.findFromDOM(editor);
    expect(view).not.toBeNull();
    view!.focus();
    view!.dispatch({ selection: { anchor: 6 } });

    // A peer inserts before this user's caret. The Yjs/CodeMirror binding
    // transforms the local selection through that remote transaction.
    shared.text.insert(0, 'REMOTE ');
    const cursorAfterRemoteEdit = view!.state.selection.main.head;
    view!.dispatch({ changes: { from: cursorAfterRemoteEdit, insert: 'X' } });

    expect(shared.text.toString()).toBe('REMOTE hello Xworld');
    expect(wholeValueChange).not.toHaveBeenCalled();
    const cursor = shared.awareness.getLocalState()?.cursor;
    expect(cursor).toMatchObject({ anchor: expect.any(Object), head: expect.any(Object) });

    unmount();
    shared.awareness.destroy();
    shared.doc.destroy();
  });

  it('converges concurrent inserts at the same position without overwriting either peer', () => {
    const alice = createSharedText('shared:');
    const bob = createSharedText();
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));

    const beforeAlice = Y.encodeStateVector(alice.doc);
    const beforeBob = Y.encodeStateVector(bob.doc);

    const { unmount } = render(
      <>
        <CollaborativeTextarea
          yText={alice.text}
          awareness={alice.awareness}
          aria-label="Alice editor"
          singleLine
        />
        <CollaborativeTextarea
          yText={bob.text}
          awareness={bob.awareness}
          aria-label="Bob editor"
          singleLine
        />
      </>,
    );

    const aliceView = EditorView.findFromDOM(
      screen.getByRole('textbox', { name: 'Alice editor' }),
    )!;
    const bobView = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Bob editor' }))!;
    aliceView.dispatch({ changes: { from: aliceView.state.doc.length, insert: 'Alice' } });
    bobView.dispatch({ changes: { from: bobView.state.doc.length, insert: 'Bob' } });

    const aliceUpdate = Y.encodeStateAsUpdate(alice.doc, beforeBob);
    const bobUpdate = Y.encodeStateAsUpdate(bob.doc, beforeAlice);
    Y.applyUpdate(alice.doc, bobUpdate);
    Y.applyUpdate(bob.doc, aliceUpdate);

    expect(alice.text.toString()).toBe(bob.text.toString());
    expect(alice.text.toString()).toContain('Alice');
    expect(alice.text.toString()).toContain('Bob');

    unmount();
    alice.awareness.destroy();
    bob.awareness.destroy();
    alice.doc.destroy();
    bob.doc.destroy();
  });

  it('shows who is editing and where their remote cursor is', () => {
    const alice = createSharedText('First line\nSecond line', 'Alice');
    const bob = createSharedText('', 'Bob', '#ef4444');
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));

    const cursor = Y.createRelativePositionFromTypeIndex(bob.text, 11);
    bob.awareness.setLocalStateField('cursor', { anchor: cursor, head: cursor });
    applyAwarenessUpdate(
      alice.awareness,
      encodeAwarenessUpdate(bob.awareness, [bob.doc.clientID]),
      'test',
    );

    const { unmount, container } = render(
      <CollaborativeTextarea
        yText={alice.text}
        awareness={alice.awareness}
        aria-label="Alice editor"
        rows={5}
      />,
    );

    expect(container.querySelector('.cm-ySelectionInfo')).toHaveTextContent('Bob');
    expect(screen.getByRole('button', { name: 'Bob · L2' })).toHaveAttribute(
      'title',
      "Show Bob's cursor",
    );

    unmount();
    alice.awareness.destroy();
    bob.awareness.destroy();
    alice.doc.destroy();
    bob.doc.destroy();
  });

  it('keeps two concurrent paragraph contributions on separate lines', () => {
    const alice = createSharedText('Shared ending', 'Alice');
    const bob = createSharedText('', 'Bob');
    Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc));

    const beforeAlice = Y.encodeStateVector(alice.doc);
    const beforeBob = Y.encodeStateVector(bob.doc);

    const { unmount } = render(
      <>
        <CollaborativeTextarea
          yText={alice.text}
          awareness={alice.awareness}
          aria-label="Alice editor"
          rows={5}
        />
        <CollaborativeTextarea
          yText={bob.text}
          awareness={bob.awareness}
          aria-label="Bob editor"
          rows={5}
        />
      </>,
    );

    const [aliceStart, bobStart] = screen.getAllByRole('button', { name: 'New paragraph' });
    fireEvent.click(aliceStart);
    fireEvent.click(bobStart);

    const aliceView = EditorView.findFromDOM(
      screen.getByRole('textbox', { name: 'Alice editor' }),
    )!;
    const bobView = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Bob editor' }))!;
    aliceView.dispatch({
      changes: { from: aliceView.state.selection.main.head, insert: 'Alice paragraph' },
    });
    bobView.dispatch({
      changes: { from: bobView.state.selection.main.head, insert: 'Bob paragraph' },
    });

    const aliceUpdate = Y.encodeStateAsUpdate(alice.doc, beforeBob);
    const bobUpdate = Y.encodeStateAsUpdate(bob.doc, beforeAlice);
    Y.applyUpdate(alice.doc, bobUpdate);
    Y.applyUpdate(bob.doc, aliceUpdate);

    expect(alice.text.toString()).toBe(bob.text.toString());
    expect(alice.text.toString().split('\n').filter(Boolean)).toEqual(
      expect.arrayContaining(['Shared ending', 'Alice paragraph', 'Bob paragraph']),
    );
    expect(alice.text.toString().split('\n').filter(Boolean)).toHaveLength(3);

    unmount();
    alice.awareness.destroy();
    bob.awareness.destroy();
    alice.doc.destroy();
    bob.doc.destroy();
  });
});
