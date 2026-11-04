// Compose production decoders, versioned publication/interaction storage and
// public views. Only the wire records, task files and S3 transport are fixtures.
import { createNativeTurnOutput } from '../../agentcore/native/turn-output.js';
import { decodeNativeTurnInteraction } from '../../agentcore/native/turn-interaction.js';
import {
  createNativePublications,
  nativePublicationView,
} from '../../shared/native-publication.js';
import {
  createNativeInteractions,
  nativeInteractionView,
} from '../../shared/native-interaction.js';
import { nativeMethodologyInteractionContract } from '../../shared/native-pending-input.js';
import {
  aidlc211Identity,
  nativeHarnessRecords,
} from '../../shared/test/fixtures/native-aidlc-211-interactions.js';
import { memoryNativeObjects } from './memory-objects.js';

export async function publishInteractionFixture({
  harness,
  spec,
  readReason = null,
  packageIdentity = aidlc211Identity,
  records,
}) {
  const identity = {
    projectId: 'project-1',
    executionId: '11111111-1111-4111-8111-111111111111',
    bindingId: '22222222-2222-4222-8222-222222222222',
    attemptId: '33333333-3333-4333-8333-333333333333',
    runtimeSessionId: '44444444-4444-4444-8444-444444444444',
    epoch: 1,
  };
  const text = [
    'Inspect this response and the saved proposal.',
    'The workflow is waiting for your reply.',
  ];
  const wire = Buffer.from(
    (records ?? nativeHarnessRecords(harness, text)).map(JSON.stringify).join('\n'),
  );
  const output = createNativeTurnOutput({ harness, nativeSessionId: 'fixture-session' });
  for (let offset = 0; offset < wire.length; offset += 17)
    output.write(wire.subarray(offset, offset + 17));
  const completed = output.finish();
  const snapshot = {
    files: [
      { path: 'aidlc/active-space', role: 'state', content: Buffer.from('default\n') },
      {
        path: 'aidlc/spaces/default/intents/active-intent',
        role: 'state',
        content: Buffer.from('fixture\n'),
      },
      {
        path: 'aidlc/spaces/default/intents/fixture/aidlc-state.md',
        role: 'state',
        content: Buffer.from(
          '- **Current Stage**: requirements-analysis\n- [?] requirements-analysis — EXECUTE\n',
        ),
      },
    ],
  };
  const decoded = decodeNativeTurnInteraction({
    interactionContract: nativeMethodologyInteractionContract(packageIdentity),
    snapshot,
    rendered: { spec, reason: readReason, bytes: Buffer.byteLength(JSON.stringify(spec)) },
    messages: completed.messages,
  });
  const options = { bucket: 'native-presentation-test', accountId: '123456789012' };
  const objects = memoryNativeObjects(options);
  const storage = { ...options, s3: objects.s3, now: () => '2026-11-04T12:00:00Z' };
  const publications = createNativePublications(storage);
  const interactions = createNativeInteractions(storage);
  const packageId = `sha256:${'a'.repeat(64)}`;
  const publicationReceipt = await publications.write({
    identity,
    packageId,
    nativeSessionId: completed.nativeSessionId,
    outcome: 'STOPPED',
    sequence: 1,
    repository: { branch: 'main', commit: 'b'.repeat(40) },
    files: snapshot.files,
  });
  const manifest = await publications.read(identity, publicationReceipt, { verifyFiles: true });
  const receipt = await interactions.write({
    identity,
    packageId,
    sequence: 1,
    harness,
    nativeSessionId: completed.nativeSessionId,
    publicationId: publicationReceipt.id,
    messages: completed.messages,
    ...decoded,
  });
  const body = await interactions.read(identity, receipt);
  return {
    identity,
    receipt,
    body,
    interactions,
    objects,
    interaction: nativeInteractionView(receipt, body),
    publication: nativePublicationView(publicationReceipt, manifest, 'complete'),
  };
}
