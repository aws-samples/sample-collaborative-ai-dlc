// Domain service for a protected package broker. No HTTP/agent route is enabled.
// The host supplies authenticated project membership, protected source bindings,
// private storage roots and the filesystem materializer. These callbacks are
// authority, never values accepted from an API request.
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalJson } from './workflow-checkpoint.js';
import {
  WorkflowSourceError,
  requireWorkflowSourceRevision,
  workflowSourceIdentity,
} from './workflow-source-bindings.js';
import { resolveReadOnlySourceCredential } from './source-control-credentials.js';
import { discoverNativeRelease, NativeReleaseCatalogError } from './native-release-catalog.js';
import {
  createNativeSourceTransport,
  NativeSourceTransportError,
} from './native-source-transport.js';
import {
  NativeReleaseValidationError,
  verifyNativeReleaseManifest,
} from './native-release-manifest.js';
import {
  NATIVE_PACKAGE_LIMITS,
  NativePackageError,
  verifyNativeReleaseDirectory,
} from './native-runtime-package.js';
import { assessNativePackageTrust, NativePackageTrustError } from './native-package-trust.js';
import {
  describeNativePackageArchiveReceipt,
  NativePackageArchiveError,
} from './native-package-archive.js';
import { describeNativePackagePin } from './native-package-pin.js';

const PROOF = 'aidlc-release.intoto.jsonl';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class NativePackageIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativePackageIntakeError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new NativePackageIntakeError(code, message);
};
const invalid = () =>
  fail('native_package_intake_invalid', 'Invalid native package intake request');
const changed = () =>
  fail('native_release_changed', 'Native release publication changed; resolve it again');

const privateRoot = async (directory) => {
  if (typeof directory !== 'string' || !isAbsolute(directory)) invalid();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) invalid();
};

const settle = async (operations) => {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map((result) => result.value);
};

const assetMap = (catalog) => {
  const version = catalog?.selection?.version;
  const names = [
    'version.json',
    'checksums.txt',
    'aidlc-linux-arm64',
    `aidlc-runtime-${version}.tar.gz`,
  ];
  if (
    !Array.isArray(catalog?.assets) ||
    catalog.assets.length < names.length ||
    catalog.assets.length > names.length + 1
  )
    invalid();
  const assets = new Map();
  for (const asset of catalog.assets) {
    if (
      (!names.includes(asset?.name) && asset?.name !== PROOF) ||
      assets.has(asset.name) ||
      typeof asset.locator !== 'string'
    )
      invalid();
    assets.set(asset.name, asset.locator);
  }
  if (names.some((name) => !assets.has(name))) invalid();
  if (
    catalog.initialFiles !== undefined &&
    (!catalog.initialFiles ||
      Object.keys(catalog.initialFiles).some((name) => name !== 'version.json'))
  )
    invalid();
  return assets;
};

const catalogIdentity = (catalog) =>
  canonicalJson({
    source: catalog.source,
    releaseId: catalog.selection.releaseId,
    tag: catalog.selection.tag,
    version: catalog.selection.version,
    prerelease: catalog.selection.prerelease,
    assets: [...assetMap(catalog)].toSorted(([a], [b]) => a.localeCompare(b)),
  });

const bindingIdentity = (binding) =>
  canonicalJson({
    projectId: binding.projectId,
    sourceId: binding.sourceId,
    revision: binding.revision,
    provider: binding.provider,
    repository: binding.repository,
    authType: binding.authType,
    credentialRef: binding.credentialRef ?? null,
    connectionUserId: binding.connectionUserId ?? null,
    connectionIdentity: binding.connectionIdentity ?? null,
    connectionCreatedAt: binding.connectionCreatedAt ?? null,
    installationId: binding.installationId ?? null,
    updatedBy: binding.updatedBy ?? null,
    projectIdentity: binding.projectIdentity ?? null,
    delegatorMembershipIdentity: binding.delegatorMembershipIdentity ?? null,
  });

const LOAD_ERRORS = Object.freeze({
  native_package_not_cached: 'The pinned native package is not available in the local cache',
  native_package_busy: 'Native package publication is busy; retry without changing its pin',
  native_package_io: 'Native package files could not be read or published',
  native_package_cleanup: 'Native package staging or publication lock could not be cleaned up',
});

const safeFailure = (error) => {
  if (
    error instanceof NativePackageIntakeError ||
    error instanceof NativePackageError ||
    error instanceof NativeReleaseValidationError ||
    error instanceof NativeReleaseCatalogError ||
    error instanceof NativeSourceTransportError ||
    error instanceof WorkflowSourceError ||
    error instanceof NativePackageTrustError ||
    error instanceof NativePackageArchiveError
  )
    return error;
  // The injected materializer may live in a separate runtime bundle. Preserve
  // only its known error codes, never an arbitrary callback's error message.
  if (error?.name === 'NativePackageLoadError' && Object.hasOwn(LOAD_ERRORS, error.code)) {
    return new NativePackageIntakeError(error.code, LOAD_ERRORS[error.code]);
  }
  // Token helpers and filesystem errors must not expose provider bodies,
  // credential references, signed URLs or local private paths.
  return new NativePackageIntakeError(
    'native_package_intake_failed',
    'Native package intake could not be completed',
  );
};

/**
 * prepare(scope + requestedRelease) returns an immutable-byte resolution for
 * review, with no filesystem paths or provider credentials. It does not verify
 * publisher authenticity, grant approval, start an agent, or enable native use.
 *
 * loadPinned({actorId, resolution}) loads a trusted server-owned resolution
 * without querying latest or downloading a replacement. Authorization and live
 * source access are checked again, even for cache hits. Execution authorization
 * and persisted confirmation belong to the caller's protected control plane.
 * When archive is configured, prepare does not return until its immutable
 * package is durably committed. A genuine cold-cache miss is restored from
 * that archive using the original pin; corruption never triggers replacement.
 *
 * loadForExecution applies the owner-selected-source policy using fresh loader
 * and source-authorization results. Present provenance requires a trusted
 * verifyBuildSignature adapter; no adapter or a verifier error denies execution.
 * A missing sidecar is recorded explicitly as absent. Returned trust evidence is
 * not an authorization token and cannot replace reauthorization on a later run.
 *
 * materialize has loadNativePackage's contract. Cache paths are derived here
 * from project/source identity; no caller-supplied cache path is accepted.
 *
 * recoverPreparation reconciles a committed package after an interrupted
 * publication lost its receipt. The host must have persisted the original
 * candidate pin/revision first. It never performs fresh release discovery.
 */
export const createNativePackageIntake = ({
  workflowSources,
  ddb,
  ssm,
  secrets,
  cacheRoot,
  workRoot,
  materialize,
  resolveCredential = resolveReadOnlySourceCredential,
  discoverRelease = discoverNativeRelease,
  createTransport = createNativeSourceTransport,
  fetchImpl = fetch,
  verifyBuildSignature,
  archive,
}) => {
  if (
    typeof workflowSources?.getAuthorizedBinding !== 'function' ||
    typeof materialize !== 'function' ||
    typeof resolveCredential !== 'function' ||
    typeof discoverRelease !== 'function' ||
    typeof createTransport !== 'function' ||
    typeof cacheRoot !== 'string' ||
    !isAbsolute(cacheRoot) ||
    typeof workRoot !== 'string' ||
    !isAbsolute(workRoot) ||
    (archive !== undefined &&
      (typeof archive?.publish !== 'function' || typeof archive?.restore !== 'function'))
  ) {
    throw new TypeError(
      'Native intake requires protected source authorization and private storage',
    );
  }

  const readAuthorizedBinding = async (scope, expected) => {
    const binding = structuredClone(await workflowSources.getAuthorizedBinding(scope));
    requireWorkflowSourceRevision(binding, scope.expectedRevision);
    const identity = workflowSourceIdentity(binding.provider, binding.repository);
    if (
      binding.projectId !== scope.projectId ||
      binding.sourceId !== scope.sourceId ||
      binding.sourceId !== identity.sourceId ||
      binding.repo !== identity.repository ||
      (expected && bindingIdentity(binding) !== bindingIdentity(expected))
    )
      invalid();
    return { binding, identity };
  };

  const authorize = async (scope, expected) => {
    const { binding, identity } = await readAuthorizedBinding(scope, expected);
    const credential = await resolveCredential({ ddb, ssm, secrets, binding, fetchImpl });
    if (
      credential?.purpose !== 'workflow-source' ||
      (binding.authType === 'public'
        ? credential.token !== null
        : typeof credential.token !== 'string' || !credential.token)
    )
      invalid();
    // Credential refresh/provider access can await external I/O. Never return
    // the permission snapshot from before that wait as current authorization.
    await readAuthorizedBinding(scope, binding);
    return { binding, identity, token: credential.token };
  };

  const cacheFor = async (scope) => {
    await privateRoot(cacheRoot);
    return join(
      cacheRoot,
      digest(
        canonicalJson({
          schemaVersion: 1,
          projectId: scope.projectId,
          sourceId: scope.sourceId,
        }),
      ),
    );
  };

  const cleanup = async (directory) => {
    if (!directory) return;
    try {
      await rm(directory, { recursive: true });
    } catch {
      fail(
        'native_package_intake_cleanup_failed',
        'Native package intake staging could not be removed',
      );
    }
  };

  const load = async ({ actorId, resolution }, forExecution) => {
    try {
      if (resolution?.schemaVersion !== 1) invalid();
      const snapshot = structuredClone(resolution);
      if (archive) {
        snapshot.archiveReceipt = describeNativePackageArchiveReceipt(
          snapshot.archiveReceipt,
          snapshot.materializationId,
        );
      }
      const scope = {
        projectId: snapshot.projectId,
        actorId,
        sourceId: snapshot.sourceId,
        expectedRevision: snapshot.bindingRevision,
      };
      const authorized = await authorize(scope);
      if (
        snapshot.packagePin?.source?.provider !== authorized.identity.provider ||
        snapshot.packagePin?.source?.repository !== authorized.identity.repository
      )
        invalid();
      const cacheDirectory = await cacheFor(scope);
      let loaded;
      const loadRequest = {
        cacheDirectory,
        pin: snapshot.packagePin,
        attestation: snapshot.attestation,
      };
      try {
        loaded = await materialize(loadRequest);
      } catch (error) {
        // This code is emitted only for an absent cache entry. A damaged entry,
        // failed read or a busy publisher must never be repaired from another
        // source (including a seemingly equivalent archived copy).
        if (
          !archive ||
          error?.name !== 'NativePackageLoadError' ||
          error.code !== 'native_package_not_cached'
        ) {
          throw error;
        }
        await authorize(scope, authorized.binding);
        loaded = await archive.restore({
          projectId: scope.projectId,
          sourceId: scope.sourceId,
          ...loadRequest,
          materializationId: snapshot.materializationId,
          receipt: snapshot.archiveReceipt,
          beforeMaterialize: () => authorize(scope, authorized.binding).then(() => undefined),
        });
        await authorize(scope, authorized.binding);
      }
      if (loaded.materializationId !== snapshot.materializationId) invalid();
      let trust;
      if (forExecution) {
        let signature;
        if (loaded.attestation === null) {
          signature = {
            status: 'absent',
            packageId: loaded.package.packageId,
            materializationId: loaded.materializationId,
            attestationSha256: null,
          };
        } else {
          if (typeof verifyBuildSignature !== 'function') {
            throw new NativePackageTrustError('native_package_trust_denied');
          }
          try {
            // This adapter is trusted broker code. No source credential is
            // forwarded and no request-supplied verification claim is accepted.
            signature = await verifyBuildSignature({
              binding: structuredClone(authorized.binding),
              materialization: structuredClone(loaded),
            });
          } catch {
            throw new NativePackageTrustError('native_package_trust_denied');
          }
        }
        trust = assessNativePackageTrust({
          binding: authorized.binding,
          materialization: loaded,
          signature,
        });
      }
      await authorize(scope, authorized.binding);
      return forExecution ? { ...loaded, trust } : loaded;
    } catch (error) {
      throw safeFailure(error);
    }
  };

  return Object.freeze({
    async prepare({ projectId, actorId, sourceId, expectedRevision, requestedRelease = 'latest' }) {
      const scope = { projectId, actorId, sourceId, expectedRevision };
      let staging;
      try {
        const authorized = await authorize(scope);
        const transport = createTransport({
          source: authorized.identity,
          token: authorized.token,
          fetchImpl,
        });
        const catalog = await discoverRelease({
          source: authorized.identity,
          requestedRelease,
          transport,
        });
        const assets = assetMap(catalog);
        if (
          catalog.source.provider !== authorized.identity.provider ||
          catalog.source.repository !== authorized.identity.repository ||
          catalog.source.release !== catalog.selection.tag
        )
          invalid();
        const selectedIdentity = catalogIdentity(catalog);
        await privateRoot(workRoot);
        staging = await mkdtemp(join(workRoot, '.native-intake-'));
        await settle(
          ['version.json', 'checksums.txt'].map(async (name) => {
            const initial = catalog.initialFiles?.[name];
            if (initial !== undefined) {
              if (
                !Buffer.isBuffer(initial) ||
                initial.length === 0 ||
                initial.length > NATIVE_PACKAGE_LIMITS.metadataBytes
              )
                invalid();
              await writeFile(join(staging, name), initial, { flag: 'wx', mode: 0o600 });
            } else {
              await transport.download(assets.get(name), {
                directory: staging,
                name,
                maxBytes: NATIVE_PACKAGE_LIMITS.metadataBytes,
              });
            }
          }),
        );
        const [versionJson, checksums] = await Promise.all([
          readFile(join(staging, 'version.json')),
          readFile(join(staging, 'checksums.txt')),
        ]);
        const manifest = verifyNativeReleaseManifest({
          versionJson,
          checksums,
          expectedRelease: catalog.source.release,
          expectedCommit: catalog.source.commit,
          target: 'linux-arm64',
        });
        const downloads = [
          manifest.assets.binary,
          manifest.assets.runtime,
          ...(assets.has(PROOF) ? [{ name: PROOF }] : []),
        ];
        const downloaded = await settle(
          downloads.map(async (asset, index) => {
            const maxBytes =
              index === 0
                ? NATIVE_PACKAGE_LIMITS.assetBytes
                : index === 1
                  ? NATIVE_PACKAGE_LIMITS.compressedBytes
                  : NATIVE_PACKAGE_LIMITS.metadataBytes;
            const actual = await transport.download(assets.get(asset.name), {
              directory: staging,
              name: asset.name,
              maxBytes: Math.min(asset.bytes ?? maxBytes, maxBytes),
            });
            if (
              asset.sha256 !== undefined &&
              (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes)
            )
              changed();
            return actual;
          }),
        );
        const pin = await verifyNativeReleaseDirectory({
          directory: staging,
          source: catalog.source,
        });
        const attestation = downloaded[2]
          ? { sha256: downloaded[2].sha256, bytes: downloaded[2].bytes }
          : null;

        // Detect publication changes observed during a rolling/multi-file read.
        // This is not a promise of a provider-wide transactional snapshot.
        const current = await discoverRelease({
          source: authorized.identity,
          requestedRelease,
          transport,
        });
        if (catalogIdentity(current) !== selectedIdentity) changed();
        const currentAssets = assetMap(current);
        const metadataPins = new Map([
          ['version.json', pin.manifestSha256],
          ['checksums.txt', pin.checksumsSha256],
          ...(attestation ? [[PROOF, attestation.sha256]] : []),
        ]);
        await settle(
          [...metadataPins].map(async ([name, expectedHash]) => {
            const bytes = await transport.bytes(currentAssets.get(name), {
              maxBytes: NATIVE_PACKAGE_LIMITS.metadataBytes,
            });
            if (digest(bytes) !== expectedHash) changed();
          }),
        );
        await authorize(scope, authorized.binding);
        const loaded = await materialize({
          releaseDirectory: staging,
          cacheDirectory: await cacheFor(scope),
          pin,
          attestation,
        });
        let archiveReceipt;
        if (archive) {
          await authorize(scope, authorized.binding);
          archiveReceipt = await archive.publish({
            projectId,
            sourceId,
            materialization: loaded,
            beforeCommit: () => authorize(scope, authorized.binding).then(() => undefined),
          });
          archiveReceipt = describeNativePackageArchiveReceipt(
            archiveReceipt,
            loaded.materializationId,
          );
        }
        // Cleanup may await filesystem I/O. Complete it before the final access
        // check so a revocation during cleanup cannot yield a resolution.
        const completedStaging = staging;
        staging = undefined;
        await cleanup(completedStaging);
        // A committed private package is not permission to read or execute it.
        await authorize(scope, authorized.binding);
        return {
          schemaVersion: 1,
          projectId,
          sourceId,
          bindingRevision: expectedRevision,
          requestedRelease,
          packagePin: loaded.package,
          attestation,
          materializationId: loaded.materializationId,
          ...(archive ? { archiveReceipt } : {}),
        };
      } catch (error) {
        throw safeFailure(error);
      } finally {
        if (staging) await cleanup(staging);
      }
    },

    async recoverPreparation({ actorId, resolution }) {
      try {
        if (typeof archive?.recoverReceipt !== 'function' || resolution?.schemaVersion !== 1) {
          invalid();
        }
        const snapshot = structuredClone(resolution);
        // A saved receipt must use exact-version restore. Reconciliation must
        // never replace it with another version of the current commit record.
        if (snapshot.archiveReceipt !== undefined) invalid();
        const pin = describeNativePackagePin(snapshot.packagePin, snapshot.attestation);
        if (
          snapshot.materializationId !== pin.materializationId ||
          !['latest', pin.identity.source.release].includes(snapshot.requestedRelease)
        ) {
          invalid();
        }
        const scope = {
          projectId: snapshot.projectId,
          actorId,
          sourceId: snapshot.sourceId,
          expectedRevision: snapshot.bindingRevision,
        };
        const authorized = await authorize(scope);
        if (
          pin.identity.source.provider !== authorized.identity.provider ||
          pin.identity.source.repository !== authorized.identity.repository
        ) {
          invalid();
        }
        const archiveReceipt = describeNativePackageArchiveReceipt(
          await archive.recoverReceipt({
            projectId: scope.projectId,
            sourceId: scope.sourceId,
            pin: snapshot.packagePin,
            attestation: snapshot.attestation,
            materializationId: snapshot.materializationId,
            beforeReturn: () => authorize(scope, authorized.binding).then(() => undefined),
          }),
          snapshot.materializationId,
        );
        await authorize(scope, authorized.binding);
        return {
          schemaVersion: 1,
          projectId: scope.projectId,
          sourceId: scope.sourceId,
          bindingRevision: scope.expectedRevision,
          requestedRelease: snapshot.requestedRelease,
          packagePin: { ...pin.identity, packageId: pin.packageId },
          attestation: pin.attestation,
          materializationId: pin.materializationId,
          archiveReceipt,
        };
      } catch (error) {
        throw safeFailure(error);
      }
    },

    loadPinned: (request) => load(request, false),
    loadForExecution: (request) => load(request, true),
  });
};
