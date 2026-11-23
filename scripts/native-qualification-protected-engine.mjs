// Same pinned engine and Bun runner as the release probe. The execution row,
// response ledger, engine journal and public proof reader share the fixture table.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNativeWorkflowEngine } from '../lambda/native-runtime-control/workflow-engine/service.js';
import {
  createNativeEngineStore,
  nativeEngineIdentity,
} from '../lambda/native-runtime-control/workflow-engine/store.js';
import { createNativeEngineProofReader } from '../lambda/native-runtime-control/workflow-engine/proof-reader.js';
import { createNativeEngineObjects } from '../lambda/shared/native-workflow-objects.js';
import {
  NATIVE_ENGINE_PROFILE,
  nativeEngineFileDigest,
} from '../lambda/shared/native-workflow-protocol.js';
import { verifyNativeReleaseDirectory } from '../lambda/shared/native-runtime-package.js';
import { describeNativePackagePin } from '../lambda/shared/native-package-pin.js';
import { prepareNativeEngineClient } from '../lambda/agentcore/native/workflow-client.js';
import { ACTOR, TABLE } from '../lambda/native-runtime-control/test/fixtures.js';
import { engineTransport } from './native-qualification-engine-transport.mjs';

export async function protectedWorkspaceEngine(
  f,
  pkg,
  storage,
  publications,
  interactions,
  membership,
) {
  const { packageId, version, sourceCommit } = NATIVE_ENGINE_PROFILE;
  assert.equal(pkg.version, version);
  const packagePin = await verifyNativeReleaseDirectory({
    directory: pkg.directory,
    source: {
      provider: 'github',
      repository: 'awslabs/aidlc-workflows',
      release: `v${version}`,
      commit: sourceCommit,
    },
  });
  assert.equal(packagePin.packageId, packageId);
  const { materializationId } = describeNativePackagePin(packagePin, null);
  Object.assign(f.prepared.candidate, { packagePin, materializationId });
  f.prepared.archiveReceipt.materializationId = materializationId;
  const digest = process.env.NATIVE_QUALIFICATION_IMAGE_DIGEST;
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  f.configuration.image = { uri: f.configuration.image.uri.split('@')[0] + '@' + digest, digest };
  const pin = {
    profileId: NATIVE_ENGINE_PROFILE.id,
    producerSha256: digest.slice(7),
    functionArn: `arn:aws:lambda:us-east-1:${storage.accountId}:function:fixture-workflow`,
    version: '1',
  };
  Object.assign(f.configuration, { packageId, materializationId, workflowEngine: pin });
  const objects = createNativeEngineObjects(storage);
  const journal = createNativeEngineStore({
    ddb: f.ddb,
    tableName: TABLE,
    readExecution: f.store.get,
    now: f.now,
  });
  const archive = await readFile(join(pkg.directory, `aidlc-runtime-${version}.tar.gz`));
  const engine = createNativeWorkflowEngine({
    executionStore: f.store,
    preparationStore: f.preparationStore,
    journal,
    objects,
    publications,
    interactions,
    authorizeAccess: async ({ row, draft }) => {
      assert.deepEqual(row.scope, f.identity);
      assert.equal(row.bindingId, draft.bindingId);
      assert.equal(row.startedBy, ACTOR);
      assert.equal(
        draft.projectIdentity,
        membership.lookup(draft.projectId, row.startedBy).projectIdentity,
      );
      if (row.response) {
        const answer = await f.store.response(row, row.response.interactionId);
        assert.equal(answer.actorId, row.response.actorId);
        const respondent = membership.lookup(draft.projectId, answer.actorId);
        assert.equal(respondent.projectIdentity, draft.projectIdentity);
        assert.deepEqual(answer.member, {
          membershipId: respondent.membershipId,
          projectIdentity: draft.projectIdentity,
        });
      }
    },
    loadArchive: async () => archive,
    loadSettings: async () => ({
      schemaVersion: 1,
      commit: f.configuration.repository.commit,
      files: [],
      filesSha256: nativeEngineFileDigest([]),
    }),
    jobsFactory: () => ({ check: assert.fail, review: assert.fail }),
    env: {
      NATIVE_WORKFLOW_ENGINE_SHA256: pin.producerSha256,
      NATIVE_WORKFLOW_ENGINE_ARN: pin.functionArn,
    },
  });
  let observedFirstNext = false;
  const lambda = {
    async send({ input }) {
      const request = JSON.parse(input.Payload);
      const result = await engine(request, {
        invokedFunctionArn: input.FunctionName,
        functionVersion: pin.version,
      });
      // Observe who received the intake directive. A CLI lifecycle hook can
      // arrive before the conductor. Never feed this private receipt to it.
      const firstNext = !observedFirstNext && request.args?.join(' ') === 'engine orchestrate next';
      if (
        request.action === 'execute' &&
        (request.expectedVersion === 0 || firstNext) &&
        result.result
      ) {
        observedFirstNext ||= firstNext;
        const saved = await objects.read(request.identity, result.result, 'output');
        const directive = saved.exitCode === 0 ? JSON.parse(saved.stdout) : null;
        console.log(
          JSON.stringify({
            probe: 'protected-intake-dispatch',
            harness: f.configuration.harness,
            attemptId: request.identity.attemptId,
            requestId: request.requestId,
            command: request.args
              .slice(0, 4)
              .map((word) => (/^[a-z-]{1,32}$/.test(word) ? word : '[argument]'))
              .join(' '),
            version: result.version,
            resultSha256: result.result.sha256,
            exitCode: saved.exitCode,
            failure: saved.failure,
            directive: directive?.kind,
            issuedProposalRequest: /--request [a-f0-9]{8}\b/.test(directive?.message ?? ''),
          }),
        );
      }
      return { Payload: Buffer.from(JSON.stringify(result)) };
    },
  };
  const transport = await engineTransport({
    identity: () => nativeEngineIdentity(f.row()),
    pin,
    lambda,
    s3: storage.s3,
  });
  return {
    ...transport,
    // The public proof omits the request-bound CLI command. Inspect only the
    // saved engine snapshot for this exact finalized revision, after admission.
    async selectedCommand(publicationId, commandId) {
      const operations = [...f.rows.values()].filter(
        (row) =>
          row.action === 'finalize' &&
          row.status === 'completed' &&
          row.publicationId === publicationId,
      );
      assert.equal(operations.length, 1);
      const [operation] = operations;
      const { state } = await objects.read(operation.identity, operation.snapshot);
      const decisions = state.decisions.filter((item) => item.commandId === commandId);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].application, 'applied');
      return decisions[0].selectedCommand;
    },
    completionProof: createNativeEngineProofReader({ ddb: f.ddb, tableName: TABLE, objects }),
    prepare: (input) => prepareNativeEngineClient({ ...input, s3: storage.s3, lambda }),
  };
}
