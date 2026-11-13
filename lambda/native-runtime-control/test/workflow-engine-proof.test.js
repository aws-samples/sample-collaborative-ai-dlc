import { randomUUID } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeEngineProofReader,
  nativeEngineVerificationSummary,
} from '../workflow-engine/proof-reader.js';
import { nativeEnginePublicationKey } from '../workflow-engine/store.js';
import {
  NATIVE_ENGINE_PROFILE,
  encodeNativeEngineFiles,
  nativeEngineFileDigest,
} from '../../shared/native-workflow-protocol.js';

const TABLE = 'native-bindings';
const fixture = () => {
  const scope = { projectId: 'project-one', executionId: randomUUID() };
  const pin = {
    profileId: NATIVE_ENGINE_PROFILE.id,
    producerSha256: 'b'.repeat(64),
    functionArn: 'arn:aws:lambda:us-east-1:123456789012:function:native-workflow',
    version: '7',
  };
  const row = {
    scope,
    bindingId: randomUUID(),
    configurationSha256: 'c'.repeat(64),
    configuration: {
      harness: 'codex',
      packageId: NATIVE_ENGINE_PROFILE.packageId,
      accountId: '123456789012',
      repository: { commit: 'e'.repeat(40) },
      workflowEngine: pin,
    },
  };
  const files = encodeNativeEngineFiles([{ path: 'src/app.js', content: Buffer.from('ok\n') }]);
  const manifest = {
    sequence: 2,
    packageId: NATIVE_ENGINE_PROFILE.packageId,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
  };
  const found = {
    identity: { attemptId: randomUUID(), epoch: 1 },
    receipt: { id: 'a'.repeat(64), manifest: { sha256: 'd'.repeat(64) } },
  };
  const identity = {
    ...scope,
    bindingId: row.bindingId,
    attemptId: found.identity.attemptId,
    epoch: 1,
    writerGeneration: 1,
    sequence: 2,
    configurationSha256: row.configurationSha256,
  };
  const evidence = {
    schemaVersion: 1,
    producer: {
      profileId: pin.profileId,
      imageSha256: pin.producerSha256,
      functionVersion: pin.version,
    },
    identity: structuredClone(identity),
    publicationId: found.receipt.id,
    publicationSequence: 2,
    publicationManifestSha256: found.receipt.manifest.sha256,
    filesSha256: nativeEngineFileDigest(manifest.files),
    configurationSha256: row.configurationSha256,
    packageId: manifest.packageId,
    harness: 'codex',
    sourceCommit: row.configuration.repository.commit,
    workflowCompletion: 'complete',
    reason: 'protected_engine_completed',
    requiredChecks: 'passed',
    finalReview: 'not_required',
    humanApproval: 'applied',
    policy: 'pinned_workflow',
    requirementsStatus: 'captured',
    policyStatus: 'protected_engine',
  };
  const key = nativeEnginePublicationKey(
    scope,
    found.identity.attemptId,
    found.identity.epoch,
    found.receipt.id,
  );
  const proof = {
    ...key,
    schemaVersion: 1,
    identity: structuredClone(identity),
    requestId: randomUUID(),
    producerSha256: pin.producerSha256,
    publicationId: found.receipt.id,
    evidence: { key: 'evidence', versionId: 'v1', sha256: 'f'.repeat(64), bytes: 10 },
  };
  const state = { proof, evidence };
  const ddb = {
    send: vi.fn(async (command) => {
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input).toMatchObject({ TableName: TABLE, Key: key, ConsistentRead: true });
      return state.proof ? { Item: structuredClone(state.proof) } : {};
    }),
  };
  const objects = {
    read: vi.fn(async (_identity, receipt, purpose) => {
      expect(receipt).toEqual(state.proof.evidence);
      expect(purpose).toBe('output');
      return structuredClone(state.evidence);
    }),
  };
  const read = (overrides = {}) =>
    createNativeEngineProofReader({ ddb, tableName: TABLE, objects })({
      row,
      found,
      manifest,
      ...overrides,
    });
  return { row, found, manifest, state, ddb, objects, read };
};

describe('protected completion proof reader', () => {
  it('keeps results without a captured engine or without a proof unverified, reading nothing extra', async () => {
    const f = fixture();
    const legacy = structuredClone(f.row);
    delete legacy.configuration.workflowEngine;
    expect(await f.read({ row: legacy })).toBeNull();
    expect(f.ddb.send).not.toHaveBeenCalled();
    f.state.proof = null;
    expect(await f.read()).toBeNull();
    expect(f.objects.read).not.toHaveBeenCalled();
  });

  it('returns evidence bound to the located publication and exposes only the summary fields', async () => {
    const f = fixture();
    const evidence = await f.read();
    expect(evidence).toEqual(f.state.evidence);
    expect(nativeEngineVerificationSummary({ ...evidence, checks: [], secret: 'x' })).toEqual({
      publicationId: f.found.receipt.id,
      publicationSequence: 2,
      workflowCompletion: 'complete',
      requiredChecks: 'passed',
      finalReview: 'not_required',
      humanApproval: 'applied',
      policy: 'pinned_workflow',
      requirementsStatus: 'captured',
      policyStatus: 'protected_engine',
      reason: 'protected_engine_completed',
    });
  });

  it.each([
    ['a proof for another publication', (s) => (s.proof.publicationId = 'e'.repeat(64))],
    ['another project', (s) => (s.proof.identity.projectId = 'project-two')],
    ['another execution', (s) => (s.proof.identity.executionId = randomUUID())],
    ['another binding', (s) => (s.proof.identity.bindingId = randomUUID())],
    ['another attempt', (s) => (s.proof.identity.attemptId = randomUUID())],
    ['another cancellation epoch', (s) => (s.proof.identity.epoch = 2)],
    ['another turn', (s) => (s.proof.identity.sequence = 1)],
    ['another configuration', (s) => (s.proof.identity.configurationSha256 = '0'.repeat(64))],
    ['another producer', (s) => (s.proof.producerSha256 = '0'.repeat(64))],
    ['an unknown proof schema', (s) => (s.proof.schemaVersion = 2)],
    ['a relocated proof row', (s) => (s.proof.sk = `${s.proof.sk}x`)],
    ['evidence for another publication', (s) => (s.evidence.publicationId = 'e'.repeat(64))],
    ['another manifest', (s) => (s.evidence.publicationManifestSha256 = '0'.repeat(64))],
    ['other result files', (s) => (s.evidence.filesSha256 = '0'.repeat(64))],
    ['another source commit', (s) => (s.evidence.sourceCommit = 'f'.repeat(40))],
    ['another package', (s) => (s.evidence.packageId = `sha256:${'0'.repeat(64)}`)],
    ['another harness', (s) => (s.evidence.harness = 'claude')],
    ['another producer image', (s) => (s.evidence.producer.imageSha256 = '0'.repeat(64))],
    ['another producer profile', (s) => (s.evidence.producer.profileId = 'other')],
    ['another function version', (s) => (s.evidence.producer.functionVersion = '8')],
    ['a different evidence identity', (s) => (s.evidence.identity.writerGeneration = 2)],
    ['another evidence sequence', (s) => (s.evidence.publicationSequence = 1)],
    ['an unknown outcome', (s) => (s.evidence.workflowCompletion = 'verified')],
    ['an unknown evidence schema', (s) => (s.evidence.schemaVersion = 2)],
  ])('rejects %s instead of reporting an outcome', async (_label, alter) => {
    const f = fixture();
    alter(f.state);
    await expect(f.read()).rejects.toMatchObject({ code: 'NATIVE_ARTIFACT_REVISION_INVALID' });
  });

  it('rejects evidence when the admitted manifest files differ from the bound digest', async () => {
    const f = fixture();
    const manifest = structuredClone(f.manifest);
    manifest.files[0].sha256 = '0'.repeat(64);
    await expect(f.read({ manifest })).rejects.toMatchObject({
      code: 'NATIVE_ARTIFACT_REVISION_INVALID',
    });
  });
});
