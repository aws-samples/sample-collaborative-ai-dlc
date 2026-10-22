import { describe, expect, it, vi } from 'vitest';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  createNativeRuntimeImagePolicy,
  nativeImageRenewalEligible,
  nativeRuntimeImageKey,
} from '../runtime-images.js';

const ACCOUNT = '123456789012';
const REPO = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/aidlc-agentcore-dev`;
const image = (hex) => ({
  uri: `${REPO}@sha256:${hex.repeat(64)}`,
  digest: `sha256:${hex.repeat(64)}`,
});
const CURRENT = image('b');
const OLD = image('a');
const env = { NATIVE_RUNTIME_ACCOUNT_ID: ACCOUNT, AWS_REGION: 'us-east-1' };
const deployment = { image: CURRENT };
const row = (status, extra = {}) => ({
  status,
  configuration: { image: structuredClone(OLD) },
  target: { imageDigest: OLD.digest },
  ...extra,
});
const policy = (revocations = {}, send) => {
  const ddb = {
    send: vi.fn(
      send ??
        (async (command) => {
          expect(command).toBeInstanceOf(GetCommand);
          expect(command.input).toMatchObject({
            TableName: 'native-bindings',
            ConsistentRead: true,
          });
          const item = revocations[command.input.Key.pk];
          return item ? { Item: item } : {};
        }),
    ),
  };
  return {
    ddb,
    images: createNativeRuntimeImagePolicy({ ddb, tableName: 'native-bindings', env }),
  };
};
const revocation = (digest, extra = {}) => ({
  ...nativeRuntimeImageKey(digest),
  schemaVersion: 1,
  digest,
  revokedAt: 1_790_000_000_000,
  revokedBy: 'arn:aws:iam::123456789012:role/Admin',
  reasonCode: 'vulnerable_image',
  ...extra,
});

describe('native runtime image policy', () => {
  it('always authorizes the current deployment image for a new or finished run', async () => {
    const { images } = policy();
    for (const status of ['REQUESTED', 'FAILED', 'STOPPED']) {
      await expect(
        images.decide({
          image: CURRENT,
          row: { status, configuration: { image: CURRENT } },
          deployment,
        }),
      ).resolves.toEqual({ status: 'current' });
    }
  });

  // Every waiting/in-flight state keeps its own protected pin after a deployment,
  // without any operator-maintained list or support-window count.
  it.each([
    'REQUESTED',
    'UPGRADING',
    'DISPATCHING',
    'RUNNING',
    'AWAITING_USER',
    'WAITING_FOR_INPUT',
    'CANCEL_REQUESTED',
  ])('retains the referenced older pin while %s', async (status) => {
    const { images } = policy();
    await expect(images.decide({ image: OLD, row: row(status), deployment })).resolves.toEqual({
      status: 'retained',
    });
  });

  it.each(['RECOVERY_REQUIRED', 'RECOVERING'])(
    'retains the pin of %s only while its recovery checkpoint is retained',
    async (status) => {
      const { images } = policy();
      const checkpoint = { id: 'c'.repeat(64) };
      await expect(
        images.decide({
          image: OLD,
          row: row(status, { recoveryCheckpoint: checkpoint, recovery: { canRecover: false } }),
          deployment,
        }),
      ).resolves.toEqual({ status: 'retained' });
      await expect(images.decide({ image: OLD, row: row(status), deployment })).resolves.toEqual({
        status: 'unapproved',
      });
    },
  );

  it.each(['STOPPED', 'FAILED', 'CANCELLED'])(
    'does not renew an older pin for a terminal %s run',
    async (status) => {
      const { images } = policy();
      await expect(images.decide({ image: OLD, row: row(status), deployment })).resolves.toEqual({
        status: 'unapproved',
      });
    },
  );
  it.each(['RECOVERY_REQUIRED', 'RECOVERING'])(
    'retains the exact workspace-mode image during %s without inventing an exact checkpoint',
    async (status) => {
      const revocations = {};
      const { images } = policy(revocations);
      const execution = row(status, {
        configuration: { image: OLD, recoveryMode: 'efs-workspace-v1' },
      });
      expect(await images.decide({ image: OLD, row: execution, deployment })).toEqual({
        status: 'retained',
      });
      revocations[nativeRuntimeImageKey(OLD.digest).pk] = revocation(OLD.digest);
      expect((await images.decide({ image: OLD, row: execution, deployment })).status).toBe(
        'revoked',
      );
      expect(nativeImageRenewalEligible({ ...execution, status: 'FAILED' })).toBe(false);
    },
  );

  it('keeps authorization independent of how many older pins are referenced', async () => {
    const { images } = policy();
    for (let index = 0; index < 64; index++) {
      const hex = index.toString(16).padStart(64, '0');
      const pinned = { uri: `${REPO}@sha256:${hex}`, digest: `sha256:${hex}` };
      await expect(
        images.decide({
          image: pinned,
          row: { status: 'AWAITING_USER', configuration: { image: pinned } },
          deployment,
        }),
      ).resolves.toEqual({ status: 'retained' });
    }
  });

  it.each([
    [
      'another repository',
      { uri: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/other@${OLD.digest}`, digest: OLD.digest },
    ],
    [
      'another account',
      {
        uri: `210987654321.dkr.ecr.us-east-1.amazonaws.com/aidlc-agentcore-dev@${OLD.digest}`,
        digest: OLD.digest,
      },
    ],
    [
      'another region',
      {
        uri: `${ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/aidlc-agentcore-dev@${OLD.digest}`,
        digest: OLD.digest,
      },
    ],
    ['a mutable tag', { uri: `${REPO}:latest`, digest: OLD.digest }],
    ['a digest mismatch', { uri: `${REPO}@sha256:${'c'.repeat(64)}`, digest: OLD.digest }],
  ])('rejects %s even for a resumable run', async (_name, pinned) => {
    const { images } = policy();
    await expect(
      images.decide({
        image: pinned,
        row: { status: 'AWAITING_USER', configuration: { image: pinned } },
        deployment,
      }),
    ).resolves.toEqual({ status: 'unapproved' });
  });

  it('rejects an image that is not the run protected pin or its upgraded target', async () => {
    const { images } = policy();
    await expect(
      images.decide({
        image: OLD,
        row: { status: 'AWAITING_USER', configuration: { image: image('c') } },
        deployment,
      }),
    ).resolves.toEqual({ status: 'unapproved' });
    await expect(
      images.decide({
        image: OLD,
        row: row('AWAITING_USER', { target: { imageDigest: CURRENT.digest } }),
        deployment,
      }),
    ).resolves.toEqual({ status: 'unapproved' });
  });

  it('gives revocation precedence over the current and retained images', async () => {
    const { images } = policy({
      [nativeRuntimeImageKey(CURRENT.digest).pk]: revocation(CURRENT.digest),
      [nativeRuntimeImageKey(OLD.digest).pk]: revocation(OLD.digest),
    });
    await expect(
      images.decide({
        image: CURRENT,
        row: { status: 'REQUESTED', configuration: { image: CURRENT } },
        deployment,
      }),
    ).resolves.toMatchObject({ status: 'revoked', revocation: { reasonCode: 'vulnerable_image' } });
    await expect(
      images.decide({ image: OLD, row: row('AWAITING_USER'), deployment }),
    ).resolves.toMatchObject({ status: 'revoked' });
    await expect(
      images.authorize({ image: OLD, row: row('RUNNING'), deployment }),
    ).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_IMAGE_REVOKED',
    });
  });

  it('treats a malformed revocation record as a revocation', async () => {
    const { images } = policy({
      [nativeRuntimeImageKey(OLD.digest).pk]: { ...nativeRuntimeImageKey(OLD.digest), junk: true },
    });
    await expect(
      images.decide({ image: OLD, row: row('RUNNING'), deployment }),
    ).resolves.toMatchObject({
      status: 'revoked',
      revocation: { reasonCode: 'revoked' },
    });
  });

  it('re-reads an absent revocation so a new revocation fences the next check', async () => {
    const revocations = {};
    const { images, ddb } = policy(revocations);
    await expect(images.decide({ image: OLD, row: row('RUNNING'), deployment })).resolves.toEqual({
      status: 'retained',
    });
    revocations[nativeRuntimeImageKey(OLD.digest).pk] = revocation(OLD.digest);
    await expect(
      images.decide({ image: OLD, row: row('RUNNING'), deployment }),
    ).resolves.toMatchObject({
      status: 'revoked',
    });
    await images.decide({ image: OLD, row: row('RUNNING'), deployment });
    expect(ddb.send).toHaveBeenCalledTimes(2);
  });

  it('fails closed when revocation state cannot be read', async () => {
    const { images } = policy({}, async () => {
      throw new Error('unavailable');
    });
    await expect(
      images.decide({ image: OLD, row: row('RUNNING'), deployment }),
    ).rejects.toMatchObject({
      code: 'NATIVE_RUNTIME_IMAGE_UNAVAILABLE',
    });
  });

  it('refuses malformed configuration instead of authorizing anything', () => {
    expect(() =>
      createNativeRuntimeImagePolicy({ ddb: {}, tableName: 'native-bindings', env }),
    ).toThrow();
    expect(() => nativeRuntimeImageKey('latest')).toThrow();
    expect(nativeImageRenewalEligible(null)).toBe(false);
  });
});
