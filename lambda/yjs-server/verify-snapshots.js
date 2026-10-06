import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as Y from 'yjs';
import { AwsStore } from './aws-store.js';
import { verifyLoadDocument } from './load.js';

/** Verify exact committed object versions against independent writer journals. */
export const verifySnapshots = async (store, result) => {
  if (!result.expectedRooms?.length) throw new Error('A journal-bearing load result is required');
  const checks = [];
  for (const expected of result.expectedRooms) {
    const manifest = await store.get(expected.documentId);
    if (!manifest?.snapshotKey || !manifest.snapshotVersion) {
      checks.push({
        documentId: expected.documentId,
        verified: false,
        reason: 'No committed checkpoint version',
      });
      continue;
    }
    const bytes = await store.load(manifest);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
      checks.push({
        documentId: expected.documentId,
        snapshotKey: manifest.snapshotKey,
        snapshotVersion: manifest.snapshotVersion,
        snapshotSequence: manifest.snapshotSequence,
        expectedWrites: expected.writes,
        actualWrites: doc.getMap('journal').size,
        verified: verifyLoadDocument(doc, expected),
      });
    } finally {
      doc.destroy();
    }
  }
  return {
    at: new Date().toISOString(),
    run: result.run,
    verified: checks.every((check) => check.verified),
    writes: checks.reduce((sum, check) => sum + (check.actualWrites ?? 0), 0),
    checks,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const store = new AwsStore({
      documentsTable: process.env.YJS_DOCUMENTS_TABLE,
      membersTable: process.env.YJS_MEMBERS_TABLE,
      bucket: process.env.YJS_SNAPSHOTS_BUCKET,
    });
    const verification = await verifySnapshots(store, result);
    console.log(JSON.stringify(verification, null, 2));
    if (!verification.verified) process.exitCode = 1;
  } catch {
    console.error(
      'Snapshot verification failed. Check the result file, AWS access, and storage configuration.',
    );
    process.exitCode = 1;
  }
}
