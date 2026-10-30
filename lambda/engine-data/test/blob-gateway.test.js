import { beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createBlobGateway } from '../blob-gateway.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
const BUCKET = 'artifacts-test';
const MIB = 1024 * 1024;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
  });
const EXECUTION = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' };
const DISCUSSION = { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' };

const rule = (filename, projectId = 'p-1') => ({
  filename,
  s3Key: `custom-rules/${projectId}/${filename}`,
});
const attachment = (attachmentId, size, overrides = {}) => ({
  attachmentId,
  filename: `${attachmentId}.png`,
  mimeType: 'image/png',
  size,
  s3Key: `intent-attachments/committed/i-1/${attachmentId}.png`,
  s3VersionId: `v-${attachmentId}`,
  ...overrides,
});

const s3Mock = mockClient(S3Client);
const s3 = new S3Client({});
let metas;
const stream = (bytes) => Readable.from([Buffer.from(bytes)]);

const gatewayWith = (overrides = {}) =>
  createBlobGateway({
    verifyGrant,
    createStore: () => ({ getExecution: async (id) => metas[id] ?? null }),
    s3,
    bucket: BUCKET,
    ...overrides,
  });

const call = async (handler, op, input, scope = EXECUTION) =>
  handler(
    JSON.parse(JSON.stringify({ op: `blob.${op}`, args: [input], grant: await grantFor(scope) })),
  );

const denial = (code) => ({
  error: expect.objectContaining({ name: 'EngineDataAccessDenied', code }),
});

// Serves `objects[key]` as a versioned object honouring Range requests the
// way S3 does (206 + ContentRange).
const serveObjects = (objects) => {
  s3Mock.on(HeadObjectCommand).callsFake(async ({ Key }) => {
    if (!(Key in objects)) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
    return { ContentLength: Buffer.byteLength(objects[Key].body), VersionId: `ver-${Key}` };
  });
  s3Mock.on(GetObjectCommand).callsFake(async ({ Key, Range, VersionId }) => {
    const object = objects[Key];
    if (!object) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const body = Buffer.from(object.body);
    if (!Range) return { Body: stream(body), VersionId: object.versionId };
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(Range).map(Number);
    const last = Math.min(end, body.length - 1);
    const slice = object.slice ? object.slice(body, start, last) : body.subarray(start, last + 1);
    return {
      Body: stream(slice),
      VersionId: object.servedVersion?.(VersionId) ?? VersionId,
      ContentRange: object.contentRange
        ? object.contentRange(start, last, body.length)
        : `bytes ${start}-${last}/${body.length}`,
    };
  });
};

beforeEach(() => {
  s3Mock.reset();
  metas = {
    'i-1': {
      projectId: 'p-1',
      intentId: 'i-1',
      customRules: [rule('a.md'), rule('b.md')],
      attachments: [attachment('att-1', 10)],
    },
  };
  serveObjects({
    'custom-rules/p-1/a.md': { body: 'Rule A' },
    'custom-rules/p-1/b.md': { body: 'Rule B' },
    'intent-attachments/committed/i-1/att-1.png': { body: '0123456789' },
  });
});

describe('blob gateway — grant, op and scope', () => {
  it('requires an engine grant and an allowlisted op with a strict input', async () => {
    const handler = gatewayWith();
    await expect(handler({ op: 'blob.readCustomRules', args: [{}] })).resolves.toEqual(
      denial('missing_grant'),
    );
    await expect(call(handler, 'readCustomRules', {}, DISCUSSION)).resolves.toEqual(
      denial('grant_mode_not_allowed'),
    );
    await expect(call(handler, 'getObject', {})).resolves.toEqual(denial('op_not_allowed'));
    await expect(
      call(handler, 'readCustomRules', { filenames: ['a.md'], bucket: 'other' }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(call(handler, 'readCustomRules', { filenames: ['../p-2/a.md'] })).resolves.toEqual(
      denial('invalid_arguments'),
    );
    await expect(
      call(handler, 'readAttachmentChunk', { attachmentId: 'att-1', offset: -1 }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(
      call(handler, 'readAttachmentChunk', {
        attachmentId: 'att-1',
        offset: 0,
        versionId: 'attacker',
      }),
    ).resolves.toEqual(denial('invalid_arguments'));
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('denies a missing or foreign execution META', async () => {
    const handler = gatewayWith();
    delete metas['i-1'];
    await expect(call(handler, 'readCustomRules', {})).resolves.toEqual(
      denial('execution_not_found'),
    );
    metas['i-1'] = { projectId: 'p-2', intentId: 'i-1', customRules: [rule('a.md', 'p-2')] };
    await expect(call(handler, 'readCustomRules', {})).resolves.toEqual(denial('scope_mismatch'));
    metas['i-1'] = { projectId: 'p-1', intentId: 'i-9', customRules: [] };
    await expect(call(handler, 'pinCustomRuleVersions', {})).resolves.toEqual(
      denial('scope_mismatch'),
    );
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('blob gateway — custom rules', () => {
  it('reads META rules, all or the named subset in request order', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'readCustomRules', {})).resolves.toEqual({
      ok: true,
      result: [
        { filename: 'a.md', body: 'Rule A' },
        { filename: 'b.md', body: 'Rule B' },
      ],
    });
    await expect(
      call(handler, 'readCustomRules', { filenames: ['b.md', 'a.md'] }),
    ).resolves.toEqual({
      ok: true,
      result: [
        { filename: 'b.md', body: 'Rule B' },
        { filename: 'a.md', body: 'Rule A' },
      ],
    });
    const keys = s3Mock.commandCalls(GetObjectCommand).map((c) => c.args[0].input);
    expect(keys.every((input) => input.Bucket === BUCKET)).toBe(true);
  });

  it('denies a rule outside META or at a key outside the exact project path', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'readCustomRules', { filenames: ['c.md'] })).resolves.toEqual(
      denial('rule_not_found'),
    );
    for (const s3Key of [
      'custom-rules/p-10/a.md',
      'custom-rules/p-2/a.md',
      'custom-rules/p-1/nested/a.md',
      'custom-rules/p-1/a.txt',
      'intent-attachments/committed/i-1/att-1.png',
    ]) {
      metas['i-1'].customRules = [rule('b.md'), { filename: 'a.md', s3Key }];
      await expect(call(handler, 'readCustomRules', { filenames: ['b.md'] })).resolves.toEqual(
        denial('rule_key_not_allowed'),
      );
      await expect(call(handler, 'pinCustomRuleVersions', {})).resolves.toEqual(
        denial('rule_key_not_allowed'),
      );
    }
    metas['i-1'].customRules = [{ filename: 'other.md', s3Key: 'custom-rules/p-1/a.md' }];
    await expect(call(handler, 'readCustomRules', {})).resolves.toEqual(
      denial('rule_key_not_allowed'),
    );
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('skips missing and oversized rules at HEAD and while streaming', async () => {
    metas['i-1'].customRules = [rule('a.md'), rule('gone.md'), rule('big.md'), rule('grew.md')];
    serveObjects({
      'custom-rules/p-1/a.md': { body: 'Rule A' },
      'custom-rules/p-1/big.md': { body: 'x'.repeat(100 * 1024 + 1) },
      'custom-rules/p-1/grew.md': { body: 'y'.repeat(200) },
    });
    s3Mock
      .on(HeadObjectCommand, { Key: 'custom-rules/p-1/grew.md' })
      .resolves({ ContentLength: 10 });
    const handler = gatewayWith({ maxRuleBytes: 100 * 1024 });
    await expect(call(handler, 'readCustomRules', {})).resolves.toEqual({
      ok: true,
      result: [
        { filename: 'a.md', body: 'Rule A' },
        { filename: 'grew.md', body: 'y'.repeat(200) },
      ],
    });
    const small = gatewayWith({ maxRuleBytes: 100 });
    await expect(call(small, 'readCustomRules', { filenames: ['grew.md'] })).resolves.toEqual({
      ok: true,
      result: [],
    });
    expect(
      s3Mock
        .commandCalls(GetObjectCommand)
        .map((c) => c.args[0].input.Key)
        .includes('custom-rules/p-1/big.md'),
    ).toBe(false);
  });

  it('pins META rules to their current versions and fails on an unversioned rule', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'pinCustomRuleVersions', {})).resolves.toEqual({
      ok: true,
      result: [
        { ...rule('a.md'), versionId: 'ver-custom-rules/p-1/a.md' },
        { ...rule('b.md'), versionId: 'ver-custom-rules/p-1/b.md' },
      ],
    });
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
    await expect(call(handler, 'pinCustomRuleVersions', {})).resolves.toEqual({
      error: expect.objectContaining({ name: 'Error' }),
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });
});

describe('blob gateway — attachment chunks', () => {
  const read = (handler, offset, attachmentId = 'att-1', scope = EXECUTION) =>
    call(handler, 'readAttachmentChunk', { attachmentId, offset }, scope);

  it('serves version-pinned fixed-size chunks with the next offset', async () => {
    const handler = gatewayWith({ chunkBytes: 4 });
    const first = await read(handler, 0);
    expect(first).toEqual({
      ok: true,
      result: {
        attachmentId: 'att-1',
        versionId: 'v-att-1',
        offset: 0,
        totalBytes: 10,
        bytesBase64: Buffer.from('0123').toString('base64'),
        nextOffset: 4,
      },
    });
    const last = await read(handler, 8);
    expect(last.result).toMatchObject({ bytesBase64: Buffer.from('89').toString('base64') });
    expect(last.result.nextOffset).toBeNull();
    expect(s3Mock.commandCalls(GetObjectCommand).map((c) => c.args[0].input)).toEqual([
      {
        Bucket: BUCKET,
        Key: 'intent-attachments/committed/i-1/att-1.png',
        VersionId: 'v-att-1',
        Range: 'bytes=0-3',
      },
      {
        Bucket: BUCKET,
        Key: 'intent-attachments/committed/i-1/att-1.png',
        VersionId: 'v-att-1',
        Range: 'bytes=8-9',
      },
    ]);
  });

  it('serves a 5 MiB attachment in 1 MiB chunks', async () => {
    const bytes = Buffer.alloc(5 * MIB, 7);
    metas['i-1'].attachments = [attachment('big', bytes.length)];
    serveObjects({ 'intent-attachments/committed/i-1/big.png': { body: bytes } });
    const handler = gatewayWith();
    const offsets = [];
    let offset = 0;
    while (offset !== null) {
      const { result } = await read(handler, offset, 'big');
      expect(Buffer.from(result.bytesBase64, 'base64').length).toBe(MIB);
      offsets.push(result.offset);
      offset = result.nextOffset;
    }
    expect(offsets).toEqual([0, MIB, 2 * MIB, 3 * MIB, 4 * MIB]);
  });

  it('denies unknown, sibling-intent, staging and unversioned attachments', async () => {
    const handler = gatewayWith();
    await expect(read(handler, 0, 'att-9')).resolves.toEqual(denial('attachment_not_found'));
    for (const overrides of [
      { s3Key: 'intent-attachments/committed/i-2/att-1.png' },
      { s3Key: 'intent-attachments/committed/i-10/att-1.png' },
      { s3Key: 'intent-attachments/staging/i-1/att-1.png' },
      { s3Key: 'intent-attachments/committed/i-1/att-2.png' },
      { s3Key: 'intent-attachments/committed/i-1/att-1.png/../x' },
      { s3VersionId: undefined },
      { size: 6 * MIB },
    ]) {
      metas['i-1'].attachments = [attachment('att-1', 10, overrides)];
      await expect(read(handler, 0)).resolves.toEqual(denial('attachment_key_not_allowed'));
    }
    metas['i-1'].attachments = [attachment('att-1', 10)];
    await expect(read(handler, 10)).resolves.toEqual(denial('invalid_arguments'));
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('rejects a changed version, a shifted range and a short body', async () => {
    const key = 'intent-attachments/committed/i-1/att-1.png';
    const handler = gatewayWith({ chunkBytes: 4 });
    const cases = [
      [{ servedVersion: () => 'v-new' }, 'attachment_version_mismatch'],
      [{ contentRange: (s, e, t) => `bytes ${s + 1}-${e}/${t}` }, 'attachment_range_mismatch'],
      [{ contentRange: (s, e) => `bytes ${s}-${e}/11` }, 'attachment_range_mismatch'],
      [{ slice: (body, s, e) => body.subarray(s, e) }, 'attachment_range_mismatch'],
      [{ contentRange: () => undefined }, 'attachment_range_mismatch'],
    ];
    for (const [behaviour, code] of cases) {
      serveObjects({ [key]: { body: '0123456789', ...behaviour } });
      await expect(read(handler, 0)).resolves.toEqual({
        error: expect.objectContaining({ name: 'EngineBlobError', code }),
      });
    }
  });

  it('fails closed without a configured bucket', async () => {
    await expect(read(gatewayWith({ bucket: undefined }), 0)).resolves.toEqual({
      error: expect.objectContaining({ code: 'blob_misconfigured' }),
    });
  });
});
