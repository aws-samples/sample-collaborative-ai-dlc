import * as Y from 'yjs';

const hasDocumentUpdates = (doc: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(doc)).size > 0;

const hashUpdate = (update: Uint8Array): number => {
  let hash = 2166136261;
  for (const byte of update) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
};

/**
 * Applies a persisted snapshot only when the live document has no updates.
 *
 * The snapshot is built twice. The first update is hashed into a deterministic
 * client ID; the second is the update that gets applied. Peers starting from
 * the same persisted snapshot therefore create byte-identical Yjs structs, so
 * simultaneous first-editor hydration is idempotent when the updates merge.
 */
export function seedYjsDocumentIfEmpty(doc: Y.Doc, populate: (seed: Y.Doc) => void): boolean {
  if (hasDocumentUpdates(doc)) return false;

  const signatureDoc = new Y.Doc();
  signatureDoc.clientID = 1;
  populate(signatureDoc);
  const signature = Y.encodeStateAsUpdate(signatureDoc);
  signatureDoc.destroy();
  if (signature.length <= 2) return false;

  const seedDoc = new Y.Doc();
  seedDoc.clientID = hashUpdate(signature);
  populate(seedDoc);
  const update = Y.encodeStateAsUpdate(seedDoc);
  seedDoc.destroy();

  Y.applyUpdate(doc, update, 'persisted-seed');
  return true;
}
