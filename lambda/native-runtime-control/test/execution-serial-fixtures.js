import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { expect, vi } from 'vitest';
import { createNativePublications } from '../../shared/native-publication.js';
import { createNativeArtifactRevisions } from '../../shared/native-artifact-revision.js';
import { TABLE } from './fixtures.js';
import { createNativeInteractions } from '../../shared/native-interaction.js';
import { createNativeExecutionApi } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { nativeTurnSequence } from '../execution-store.js';
import { executionFixture } from './execution-fixtures.js';

export const SERIAL_SOURCE = { branch: 'develop', commit: 'e'.repeat(40) };

// Uses the production authority store and both immutable S3 codecs. Only AWS
// transport is local; no canned manifests, interaction hashes or receipt IDs.
export const serialFixture = () => {
  const f = executionFixture();
  const objects = new Map();
  const reads = [];
  let version = 0;
  const s3 = {
    send: vi.fn(async (command) => {
      const input = command.input;
      expect(input.Bucket).toBe(f.configuration.publicationBucket);
      expect(input.ExpectedBucketOwner).toBe(f.configuration.accountId);
      if (command instanceof PutObjectCommand) {
        const VersionId = `serial-${++version}`;
        objects.set(`${input.Key}\0${VersionId}`, Buffer.from(input.Body));
        return { VersionId };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      reads.push(input);
      const bytes = objects.get(`${input.Key}\0${input.VersionId}`);
      if (!bytes) throw new Error('Unknown immutable object version');
      return {
        VersionId: input.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    }),
  };
  const ports = {
    s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
    now: () => new Date(f.now()).toISOString(),
  };
  const publications = createNativePublications(ports);
  const interactions = createNativeInteractions(ports);
  const authorization = { member: true };
  const recheck = vi.fn(async () => {
    if (!authorization.member)
      throw Object.assign(new Error('Membership revoked'), {
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
  });
  const enqueue = vi.fn(async () => {});
  const configure = vi.fn(async () => f.configuration);
  const makeApi = (enabled = true) =>
    createNativeExecutionApi({
      enabled,
      store: f.store,
      publications,
      revisions: createNativeArtifactRevisions({ ddb: f.ddb, nativeTable: TABLE, publications }),
      interactions,
      enqueue,
      configure,
      authorizeSource: vi.fn(async () => {}),
      recheck,
    });
  const turn = async (sequence = nativeTurnSequence(f.row()), options = {}) => {
    const identity = executionIdentity(f.row());
    const nativeSessionId = 'actual-native-session';
    const receipt = await publications.write({
      identity,
      sequence,
      nativeSessionId,
      packageId: f.configuration.packageId,
      outcome: 'STOPPED',
      repository: SERIAL_SOURCE,
      ...(options.sourceBaseline ? { sourceBaseline: options.sourceBaseline } : {}),
      files: options.files ?? [
        { path: 'src/game.js', role: 'code', content: Buffer.from(`// turn ${sequence}\n`) },
      ],
    });
    const interactionReceipt = await interactions.write({
      identity,
      sequence,
      nativeSessionId,
      publicationId: receipt.id,
      packageId: f.configuration.packageId,
      harness: options.harness ?? f.configuration.harness,
      messages: [
        { type: 'text', text: options.text ?? `Question ${sequence}: what should change?` },
      ],
      ...(options.pendingInput ? { pendingInput: options.pendingInput } : {}),
    });
    const body = await interactions.read(identity, interactionReceipt);
    return { receipt, interactionReceipt, body };
  };
  const ready = async () => {
    await f.start();
    const claim = await f.store.claim(f.bindingIdentity);
    const dispatching = await f.store.advance({
      row: claim.row,
      patch: {
        status: 'DISPATCHING',
        target: f.target(claim.row),
        sourceBranch: SERIAL_SOURCE.branch,
        sourceCommit: SERIAL_SOURCE.commit,
      },
    });
    const running = await f.store.advance({ row: dispatching, patch: { status: 'RUNNING' } });
    return f.store.release({ row: running });
  };
  const publish = async ({ project = true, ...options } = {}) => {
    const produced = await turn(undefined, options);
    const claim = await f.store.claim(f.bindingIdentity);
    const published = await f.store.publish({
      row: claim.row,
      publication: produced.receipt,
      interaction: produced.interactionReceipt,
      interactionContentSha256: produced.body.contentSha256,
    });
    const row = project
      ? await f.store.projected({ row: published })
      : await f.store.release({ row: published });
    return { ...produced, row };
  };
  const replyRequest = (overrides = {}) => ({
    requestId: randomUUID(),
    interactionId: f.row().interaction.id,
    contentSha256: f.row().interactionContentSha256,
    text: 'Keep the original task; adjust only the pipe appearance.\n',
    ...overrides,
  });
  const respond = (request = replyRequest(), actorId = 'responding-member') =>
    f.store.respond({ ...f.bindingIdentity, actorId, request });
  return {
    ...f,
    publications,
    interactions,
    authorization,
    recheck,
    enqueue,
    configure,
    api: makeApi(),
    makeApi,
    ready,
    turn,
    publish,
    replyRequest,
    respond,
    reads,
    objects,
  };
};
