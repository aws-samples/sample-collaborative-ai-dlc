import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { seedYjsDocumentIfEmpty } from './yjsSeed';

const populate = (doc: Y.Doc) => {
  doc.getText('title').insert(0, 'Shared title');
  doc.getText('body').insert(0, 'Persisted body');
  doc.getMap('config').set('scope', 'feature');
};

describe('seedYjsDocumentIfEmpty', () => {
  it('deduplicates identical snapshots seeded concurrently by two first editors', () => {
    const alice = new Y.Doc();
    const bob = new Y.Doc();

    expect(seedYjsDocumentIfEmpty(alice, populate)).toBe(true);
    expect(seedYjsDocumentIfEmpty(bob, populate)).toBe(true);

    const aliceUpdate = Y.encodeStateAsUpdate(alice);
    const bobUpdate = Y.encodeStateAsUpdate(bob);
    Y.applyUpdate(alice, bobUpdate);
    Y.applyUpdate(bob, aliceUpdate);

    expect(alice.getText('title').toString()).toBe('Shared title');
    expect(alice.getText('body').toString()).toBe('Persisted body');
    expect(alice.getMap('config').get('scope')).toBe('feature');
    expect(Y.encodeStateVector(alice)).toEqual(Y.encodeStateVector(bob));

    alice.destroy();
    bob.destroy();
  });

  it('never seeds over live collaboration updates', () => {
    const doc = new Y.Doc();
    doc.getText('body').insert(0, 'Live edit');

    expect(seedYjsDocumentIfEmpty(doc, populate)).toBe(false);
    expect(doc.getText('body').toString()).toBe('Live edit');
    expect(doc.getText('title').toString()).toBe('');

    doc.destroy();
  });
});
