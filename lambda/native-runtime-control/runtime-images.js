// Protected runtime-image authorization for native executions.
//
// Approval is reference-based. The trusted API pins the deployment image into
// the protected execution row when a run starts; agent runtimes and members
// cannot write that table. After a later deployment, the run's own pin stays
// authorized for as long as the run can still resume or retains a recovery
// checkpoint. Nothing needs to be listed by an operator, so deployment
// configuration cannot drop a still-required pin. The pin must remain the
// exact immutable digest in this deployment's account, region and repository.
//
// Administrator revocation records are written by the operator script only.
// Revocation always wins, even for the current deployment image, and it only
// blocks execution: committed publications, files, interactions and graphs
// remain readable.
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { nativeWorkspaceRecovery } from '../shared/native-recovery-mode.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const URI =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9@._:/+=-]{0,255}$/;
// Statuses that may still request credentials, deliver an answer or continue a
// session: ordinary replies (AWAITING_USER), structured waiting points
// (WAITING_FOR_INPUT) and every in-flight state. STOPPED/FAILED/CANCELLED
// never renew.
const RESUMABLE = new Set([
  'REQUESTED',
  'UPGRADING',
  'DISPATCHING',
  'RUNNING',
  'AWAITING_USER',
  'WAITING_FOR_INPUT',
  'CANCEL_REQUESTED',
]);
// Recovery keeps the selected mode's image: a retained exact checkpoint, or
// the surviving-workspace protocol. Eligibility never grants a new writer.
const RECOVERY = new Set(['RECOVERY_REQUIRED', 'RECOVERING']);

export class NativeRuntimeImageError extends Error {
  constructor(code) {
    super('Native runtime image is not authorized for this execution');
    this.name = 'NativeRuntimeImageError';
    this.code = code;
  }
}
const deny = (code) => {
  throw new NativeRuntimeImageError(code);
};
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const imageValid = (image, accountId, region) =>
  image !== null &&
  typeof image === 'object' &&
  Object.keys(image).length === 2 &&
  matches(image.digest, DIGEST) &&
  matches(image.uri, URI) &&
  image.uri.endsWith(`@${image.digest}`) &&
  matches(accountId, /^[0-9]{12}$/) &&
  image.uri.startsWith(`${accountId}.dkr.ecr.${region}.`);
const repository = (image) => image.uri.slice(0, image.uri.lastIndexOf('@'));

export const nativeRuntimeImageKey = (digest) => {
  if (!matches(digest, DIGEST)) deny('NATIVE_RUNTIME_IMAGE_INVALID');
  return { pk: `NATIVE_RUNTIME_IMAGE#${digest}`, sk: 'REVOCATION' };
};

/** True while the run's pinned image must stay usable for renewal/recovery. */
export const nativeImageRenewalEligible = (row) =>
  Boolean(row) &&
  (RESUMABLE.has(row.status) ||
    (RECOVERY.has(row.status) &&
      (nativeWorkspaceRecovery(row.configuration) || Boolean(row.recoveryCheckpoint))));

const revocationValue = (item, digest) => {
  const key = nativeRuntimeImageKey(digest);
  if (
    item === null ||
    typeof item !== 'object' ||
    item.pk !== key.pk ||
    item.sk !== key.sk ||
    item.schemaVersion !== 1 ||
    item.digest !== digest ||
    !Number.isSafeInteger(item.revokedAt) ||
    item.revokedAt < 1 ||
    !matches(item.reasonCode, REASON) ||
    !matches(item.revokedBy, ACTOR)
  )
    // A malformed record is still an administrator's intent to revoke.
    return { digest, revokedAt: null, reasonCode: 'revoked' };
  return { digest, revokedAt: item.revokedAt, reasonCode: item.reasonCode };
};

/**
 * decide() returns {status: 'current' | 'retained' | 'revoked' | 'unapproved'};
 * authorize() throws NATIVE_EXECUTION_IMAGE_REVOKED or _UNAPPROVED instead.
 * `image` must be the run's own protected pin (row.configuration.image) and
 * `deployment.image` this deployment's configured image. An unreadable
 * revocation store fails closed with NATIVE_RUNTIME_IMAGE_UNAVAILABLE.
 */
export const createNativeRuntimeImagePolicy = ({ ddb, tableName, env = process.env }) => {
  if (typeof ddb?.send !== 'function' || !matches(tableName, /^[A-Za-z0-9_.-]{3,255}$/))
    deny('NATIVE_RUNTIME_IMAGE_UNAVAILABLE');
  const cache = new Map();
  const revocation = async (digest) => {
    if (cache.has(digest)) return cache.get(digest);
    let result;
    try {
      result = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: nativeRuntimeImageKey(digest),
          ConsistentRead: true,
        }),
      );
    } catch {
      deny('NATIVE_RUNTIME_IMAGE_UNAVAILABLE');
    }
    const value = result?.Item === undefined ? null : revocationValue(result.Item, digest);
    // Revocations are permanent, so caching a positive result is safe. Absence
    // is re-read on every call: a new revocation fences the very next check.
    if (value) cache.set(digest, value);
    return value;
  };
  const decide = async ({ image, row, deployment }) => {
    const accountId = env.NATIVE_RUNTIME_ACCOUNT_ID;
    const region = env.AWS_REGION;
    if (!imageValid(image, accountId, region) || !imageValid(deployment?.image, accountId, region))
      return { status: 'unapproved' };
    const revoked = await revocation(image.digest);
    if (revoked) return { status: 'revoked', revocation: revoked };
    if (image.uri === deployment.image.uri && image.digest === deployment.image.digest)
      return { status: 'current' };
    const pin = row?.configuration?.image;
    if (
      pin?.uri === image.uri &&
      pin?.digest === image.digest &&
      // Never follow a pin into another account, region or repository.
      repository(image) === repository(deployment.image) &&
      // An upgraded target must still execute exactly the pinned digest.
      (row.target === undefined || row.target.imageDigest === image.digest) &&
      nativeImageRenewalEligible(row)
    )
      return { status: 'retained' };
    return { status: 'unapproved' };
  };
  return Object.freeze({
    revocation,
    decide,
    async authorize(input) {
      const decision = await decide(input);
      if (decision.status === 'revoked') deny('NATIVE_EXECUTION_IMAGE_REVOKED');
      if (decision.status === 'unapproved') deny('NATIVE_EXECUTION_IMAGE_UNAPPROVED');
      return decision;
    },
  });
};
