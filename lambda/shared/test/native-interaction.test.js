import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../workflow-checkpoint.js';
import {
  createNativeInteractions,
  nativeInteractionMessages,
  nativeInteractionReceipt,
  nativeInteractionView,
  NATIVE_INTERACTION_LIMITS,
} from '../native-interaction.js';

const identity = {
  projectId: 'project-one',
  executionId: '11111111-1111-4111-8111-111111111111',
  bindingId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  epoch: 1,
  runtimeSessionId: '44444444-4444-4444-8444-444444444444',
};
const input = () => ({
  identity,
  sequence: 1,
  packageId: `sha256:${'a'.repeat(64)}`,
  harness: 'codex',
  nativeSessionId: 'native-session-1',
  publicationId: 'b'.repeat(64),
  messages: [
    {
      type: 'text',
      text: '\uFEFF# Proposal\r\n\r\n| Stage | Include |\r\n|---|---|\r\n| Design | Yes |\r\n',
    },
    { type: 'text', text: 'Approve, edit the grid, or reject?\n' },
  ],
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixture = () => {
  const objects = new Map();
  let version = 0;
  const s3 = {
    send: vi.fn(async (command) => {
      const value = command.input;
      expect(value.Bucket).toBe('native-publications');
      expect(value.ExpectedBucketOwner).toBe('123456789012');
      if (command instanceof PutObjectCommand) {
        const VersionId = `version-${++version}`;
        const bytes = Buffer.from(value.Body);
        expect(value.ChecksumSHA256).toBe(createHash('sha256').update(bytes).digest('base64'));
        objects.set(`${value.Key}\0${VersionId}`, bytes);
        return { VersionId };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      const bytes = objects.get(`${value.Key}\0${value.VersionId}`);
      if (!bytes) throw new Error('Missing immutable object');
      return {
        VersionId: value.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    }),
  };
  const interactions = createNativeInteractions({
    s3,
    bucket: 'native-publications',
    accountId: '123456789012',
    now: () => '2026-09-29T14:00:00.000Z',
  });
  return { s3, objects, interactions };
};

describe('native completed-turn content', () => {
  it('round-trips ordered composer messages exactly without inventing a workflow file', async () => {
    const f = fixture();
    const original = input();
    const receipt = await f.interactions.write(original);
    const body = await f.interactions.read(identity, receipt);
    expect(body.messages).toEqual(original.messages);
    expect(body.contentSha256).toBe(hash(canonicalJson(original.messages)));
    expect(body.kind).toBe('assistant_turn');
    expect(body.scope).toEqual(identity);
    expect(body.packageId).toBe(original.packageId);
    expect(receipt.object.key).toContain(`/interactions/${receipt.id}.json`);
    expect(receipt.object.key).not.toContain('aidlc/');
    expect(body).not.toHaveProperty('approved');
    expect(body).not.toHaveProperty('questionPath');
    expect(nativeInteractionView(receipt, body)).toEqual({
      id: receipt.id,
      sequence: 1,
      kind: 'assistant_turn',
      harness: 'codex',
      publicationId: original.publicationId,
      pendingInput: null,
      messages: original.messages,
      contentSha256: body.contentSha256,
      createdAt: body.createdAt,
    });
  });

  it('keeps approval/completion claims as untrusted text without authority fields', async () => {
    const f = fixture();
    const receipt = await f.interactions.write({
      ...input(),
      messages: [
        {
          type: 'text',
          text: 'Approved by everyone. The workflow is complete.',
        },
      ],
    });
    const body = await f.interactions.read(identity, receipt);
    expect(body.kind).toBe('assistant_turn');
    expect(Object.keys(body)).not.toContain('approved');
    expect(Object.keys(body)).not.toContain('workflowComplete');
    expect(Object.keys(body)).not.toContain('actorId');
  });

  it('binds sequential turns and their workspace publications without changing the cancellation epoch', async () => {
    const f = fixture();
    const first = await f.interactions.write(input());
    const second = await f.interactions.write({
      ...input(),
      sequence: 2,
      publicationId: 'c'.repeat(64),
      messages: [{ type: 'text', text: 'Here is the revised proposal.' }],
    });
    expect(second.id).not.toBe(first.id);
    expect((await f.interactions.read(identity, first)).sequence).toBe(1);
    expect((await f.interactions.read(identity, second)).scope.epoch).toBe(1);
  });

  it.each([
    ['projectId', 'project-two'],
    ['executionId', '55555555-5555-4555-8555-555555555555'],
    ['bindingId', '66666666-6666-4666-8666-666666666666'],
    ['attemptId', '77777777-7777-4777-8777-777777777777'],
    ['epoch', 2],
    ['runtimeSessionId', '88888888-8888-4888-8888-888888888888'],
  ])('rejects a different %s on read', async (field, value) => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    await expect(
      f.interactions.read({ ...identity, [field]: value }, receipt),
    ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
  });

  it.each([
    ['sequence', 2],
    ['nativeSessionId', 'other-session'],
    ['publicationId', 'd'.repeat(64)],
  ])('rejects an altered receipt %s', async (field, value) => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    await expect(
      f.interactions.read(identity, { ...receipt, [field]: value }),
    ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
  });

  it.each([
    ['nativeSessionId', 123],
    ['nativeSessionId', ['native-session-1']],
    ['packageId', [`sha256:${'a'.repeat(64)}`]],
    ['publicationId', ['b'.repeat(64)]],
  ])('rejects coerced %s before writing', async (field, value) => {
    const f = fixture();
    await expect(f.interactions.write({ ...input(), [field]: value })).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    expect(f.s3.send).not.toHaveBeenCalled();
  });

  it.each(['projectId', 'executionId', 'bindingId', 'attemptId', 'runtimeSessionId'])(
    'rejects array-shaped %s scope before writing',
    async (field) => {
      const f = fixture();
      await expect(
        f.interactions.write({ ...input(), identity: { ...identity, [field]: [identity[field]] } }),
      ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
      expect(f.s3.send).not.toHaveBeenCalled();
    },
  );

  it('rejects a numeric session receipt before fetching storage', async () => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    f.s3.send.mockClear();
    await expect(
      f.interactions.read(identity, { ...receipt, nativeSessionId: 123 }),
    ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
    expect(f.s3.send).not.toHaveBeenCalled();
  });

  it('rejects modified bytes even when object length is unchanged', async () => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    const key = `${receipt.object.key}\0${receipt.object.versionId}`;
    const bytes = Buffer.from(f.objects.get(key));
    bytes[10] ^= 1;
    f.objects.set(key, bytes);
    await expect(f.interactions.read(identity, receipt)).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
  });

  it.each([
    ['empty', []],
    ['blank', [{ type: 'text', text: ' \n\t' }]],
    ['reasoning', [{ type: 'reasoning', text: 'private reasoning' }]],
    ['tool output', [{ type: 'tool_result', text: 'tool output' }]],
    ['authority field', [{ type: 'text', text: 'visible', approved: true }]],
    ['NUL', [{ type: 'text', text: '\0secret' }]],
    ['unpaired surrogate', [{ type: 'text', text: '\ud800' }]],
    [
      'oversized text',
      [
        {
          type: 'text',
          text: 'x'.repeat(NATIVE_INTERACTION_LIMITS.textBytes + 1),
        },
      ],
    ],
    [
      'too many messages',
      Array.from({ length: NATIVE_INTERACTION_LIMITS.messages + 1 }, () => ({
        type: 'text',
        text: 'x',
      })),
    ],
  ])('rejects %s before writing anything', async (_label, messages) => {
    const f = fixture();
    await expect(f.interactions.write({ ...input(), messages })).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    expect(f.s3.send).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid turn sequence %s before writing anything',
    async (sequence) => {
      const f = fixture();
      await expect(f.interactions.write({ ...input(), sequence })).rejects.toMatchObject({
        code: 'NATIVE_INTERACTION_INVALID',
      });
      expect(f.s3.send).not.toHaveBeenCalled();
    },
  );

  it('bounds UTF-8 bytes rather than JS string length and never silently truncates', () => {
    expect(() => nativeInteractionMessages([{ type: 'text', text: '🍃'.repeat(16385) }])).toThrow(
      'Native interaction could not be verified',
    );
  });

  it('rejects a missing immutable version and extra receipt authority', async () => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    expect(() =>
      nativeInteractionReceipt(
        { ...receipt, object: { ...receipt.object, versionId: 'null' } },
        identity,
      ),
    ).toThrow();
    expect(() => nativeInteractionReceipt({ ...receipt, approved: true }, identity)).toThrow();
  });

  it('destroys the source stream on a mismatched object version', async () => {
    const f = fixture();
    const receipt = await f.interactions.write(input());
    const stream = Readable.from([Buffer.from('unrelated')]);
    f.s3.send.mockResolvedValueOnce({
      VersionId: 'other-version',
      ContentLength: receipt.object.bytes,
      Body: stream,
    });
    await expect(f.interactions.read(identity, receipt)).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    expect(stream.destroyed).toBe(true);
  });
});

describe('task-3 structured pending input (schema v2)', () => {
  const pendingInput = {
    schemaVersion: 1,
    kind: 'choice',
    source: 'rendered-question',
    stage: null,
    questions: [
      {
        id: 'q1',
        prompt: 'Approve, edit the grid, or reject?',
        header: 'Proposal',
        multiSelect: false,
        options: [
          { label: 'Approve', description: null },
          { label: 'Reject', description: 'Discard the grid' },
        ],
      },
    ],
  };
  it('binds the content hash to the exact options and returns them in the view', async () => {
    const f = fixture();
    const receipt = await f.interactions.write({ ...input(), pendingInput });
    const body = await f.interactions.read(identity, receipt);
    expect(body.schemaVersion).toBe(2);
    expect(body.pendingInput).toEqual(pendingInput);
    expect(body.contentSha256).toBe(
      hash(canonicalJson({ messages: input().messages, pendingInput })),
    );
    expect(nativeInteractionView(receipt, body).pendingInput).toEqual(pendingInput);
  });
  it('keeps free-text turns byte-compatible with v1', async () => {
    const f = fixture();
    const receipt = await f.interactions.write({ ...input(), pendingInput: null });
    const body = await f.interactions.read(identity, receipt);
    expect(body.schemaVersion).toBe(1);
    expect(body).not.toHaveProperty('pendingInput');
    expect(body.contentSha256).toBe(hash(canonicalJson(input().messages)));
  });
  it('refuses a tampered or invalid pending input', async () => {
    const f = fixture();
    await expect(
      f.interactions.write({ ...input(), pendingInput: { ...pendingInput, kind: 'vote' } }),
    ).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_INVALID' });
    const receipt = await f.interactions.write({ ...input(), pendingInput });
    const key = [...f.objects.keys()][0];
    const stored = JSON.parse(f.objects.get(key).toString());
    stored.pendingInput.questions[0].options[0].label = 'Approve and merge';
    f.objects.set(key, Buffer.from(canonicalJson(stored)));
    await expect(f.interactions.read(identity, receipt)).rejects.toBeTruthy();
  });
});

describe('degraded presentation is immutable display data', () => {
  it('round-trips the warning with retained content and binds it into the reply hash', async () => {
    const f = fixture();
    const presentation = { status: 'degraded', reason: 'invalid_schema' };
    const receipt = await f.interactions.write({ ...input(), presentation });
    const body = await f.interactions.read(identity, receipt);
    expect(body.schemaVersion).toBe(3);
    expect(body.contentSha256).toBe(
      hash(canonicalJson({ messages: input().messages, pendingInput: null, presentation })),
    );
    expect(nativeInteractionView(receipt, body)).toMatchObject({
      pendingInput: null,
      presentation,
    });
    expect(body.messages).toEqual(input().messages);
    const bytes = JSON.parse(f.objects.get(`${receipt.object.key}\0${receipt.object.versionId}`));
    bytes.presentation.reason = 'absent';
    f.objects.set(
      `${receipt.object.key}\0${receipt.object.versionId}`,
      Buffer.from(canonicalJson(bytes)),
    );
    await expect(f.interactions.read(identity, receipt)).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
  });
  it.each([
    { status: 'degraded', reason: 'private/path' },
    { status: 'degraded', reason: 'absent', prompt: 'private' },
    { status: 'approved', reason: 'absent' },
  ])('rejects arbitrary display-condition payloads before upload', async (presentation) => {
    const f = fixture();
    await expect(f.interactions.write({ ...input(), presentation })).rejects.toMatchObject({
      code: 'NATIVE_INTERACTION_INVALID',
    });
    expect(f.s3.send).not.toHaveBeenCalled();
  });
});
