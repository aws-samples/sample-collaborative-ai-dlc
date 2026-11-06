import { afterEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { materializeAttachments, attachmentReferences } from '../attachments.js';
import { nativeExecutionInputs, nativeInputSnapshot } from '../../shared/native-inputs.js';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, '.aidlc/references'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
const fixture = async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'native-materialized-input-'));
  roots.push(workspaceDir);
  const draft = { projectId: 'project', executionId: randomUUID(), request: {} };
  const inputs = nativeInputSnapshot(draft, 'native-inputs');
  const bytes = Buffer.from('Exact input bytes.\n');
  const attachmentId = randomUUID();
  const file = {
    attachmentId,
    filename: 'input.md',
    mimeType: 'text/markdown',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    s3Key: `intent-attachments/committed/${inputs.storageId}/${attachmentId}.md`,
    s3VersionId: 'exact-version',
  };
  const calls = [];
  const client = {
    send: async (command) => {
      calls.push(command);
      expect(command.input).toEqual({
        Bucket: 'native-inputs',
        Key: file.s3Key,
        VersionId: 'exact-version',
        ExpectedBucketOwner: '123456789012',
      });
      return { Body: Readable.from([bytes]) };
    },
  };
  const args = {
    workspaceDir,
    attachments: [file],
    client,
    bucket: 'native-inputs',
    strict: true,
    expectedBucketOwner: '123456789012',
  };
  return { args, bytes, file, calls, workspaceDir, inputs };
};
it('revalidates and restores changed reference bytes from the pinned object version', async () => {
  const f = await fixture();
  const result = await materializeAttachments(f.args);
  const filename = join(f.workspaceDir, result.attachments[0].path);
  await chmod(filename, 0o644);
  await writeFile(filename, Buffer.alloc(f.bytes.length, 'x'));
  await chmod(filename, 0o444);
  await materializeAttachments(f.args);
  expect(await readFile(filename)).toEqual(f.bytes);
  expect(f.calls).toHaveLength(2);
  await materializeAttachments(f.args);
  expect(f.calls).toHaveLength(2);
});
it.each(['parent', 'directory', 'manifest', 'file'])(
  'does not follow a %s symlink when delivering native inputs',
  async (kind) => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'native-outside-input-'));
    roots.push(outside);
    await writeFile(join(outside, 'protected'), 'unchanged');
    if (kind === 'parent') await symlink(outside, join(f.workspaceDir, '.aidlc'));
    else {
      await mkdir(join(f.workspaceDir, '.aidlc/references'), { recursive: true });
      if (kind === 'directory') {
        await rm(join(f.workspaceDir, '.aidlc/references'), { recursive: true });
        await symlink(outside, join(f.workspaceDir, '.aidlc/references'));
      } else if (kind === 'manifest')
        await symlink(
          join(outside, 'protected'),
          join(f.workspaceDir, '.aidlc/references/manifest.json'),
        );
      else
        await symlink(
          join(outside, 'protected'),
          join(f.workspaceDir, attachmentReferences([f.file])[0].path),
        );
    }
    if (kind === 'parent' || kind === 'directory')
      await expect(materializeAttachments(f.args)).rejects.toThrow();
    else await materializeAttachments(f.args);
    expect(await readFile(join(outside, 'protected'), 'utf8')).toBe('unchanged');
  },
);
it('rejects a different body, missing bytes and oversized streams without a partial success', async () => {
  const f = await fixture();
  for (const bytes of [
    Buffer.from('different content'),
    Buffer.alloc(0),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  ]) {
    const client = { send: async () => ({ Body: Readable.from([bytes]) }) };
    await expect(materializeAttachments({ ...f.args, client })).rejects.toThrow();
  }
});
it('rejects foreign storage scopes and secret-shaped metadata at the runtime contract', async () => {
  const f = await fixture();
  for (const patch of [
    { s3Key: 'another-project/secret' },
    { token: 'forged-token' },
    { filename: '../../escape.md' },
  ]) {
    const inputs = { ...f.inputs, attachments: [{ ...f.file, ...patch }] };
    await expect(async () => nativeExecutionInputs(inputs)).rejects.toThrow();
  }
});
