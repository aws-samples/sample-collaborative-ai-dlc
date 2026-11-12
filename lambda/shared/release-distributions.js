// Native harness distributions a custom fork release ships.
//
// A native export ships a harness distribution (`dist/<harness>/`) alongside the
// intent's projection. For an official release that is fetched lazily from the
// official repository at the intent's commit. A custom fork's commit is not in
// the official repository, so the fork's own distributions are captured when
// the release is imported (seed-blocks importRelease, which already reads the
// fork with the configured source credentials) and stored beside the release
// closure. A native export then reads them from storage, with no repository
// access or credential of its own.
//
// They sit under the release's own key prefix, `<release prefix>/dist/`, so
// they share its immutability and its custom-vs-official separation, and no new
// storage permission is needed: the import role already writes release storage
// and the intents role already reads it. They are not part of the closure: the
// manifest, its digest and the compatibility record are unchanged, so capturing
// them never changes what a pinned intent runs or what certification judged.
//
// Each harness is stored as `<harness>.tar.gz` plus `<harness>.manifest.json`,
// the same shapes the native export cache uses. The manifest is written last
// and is the publication marker.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { buildDistributionArchive, safeDistributionPath } from './distribution-archive.js';
import { releaseKeyPrefix } from './aidlc-release.js';

// The harnesses a native export can ship. Keep in step with the native export's
// HARNESS_DATA_DIRS (lambda/intents/native-export.js).
const NATIVE_DISTRIBUTION_HARNESSES = Object.freeze([
  'claude',
  'codex',
  'kiro',
  'kiro-ide',
  'opencode',
]);

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

const releaseDistributionKeys = (keyArgs, harness) => {
  if (!NATIVE_DISTRIBUTION_HARNESSES.includes(harness)) {
    throw new Error(`release-distributions: unsupported harness ${harness}`);
  }
  const prefix = `${releaseKeyPrefix(keyArgs)}/dist`;
  return {
    archive: `${prefix}/${harness}.tar.gz`,
    manifest: `${prefix}/${harness}.manifest.json`,
  };
};

// Groups repository files under `dist/<harness>/` by harness, with paths made
// relative to that harness root. Unknown harness folders are ignored.
const splitReleaseDistributions = (files) => {
  const byHarness = new Map();
  for (const [path, body] of files) {
    const match = /^dist\/([^/]+)\/(.+)$/.exec(path);
    if (!match || !NATIVE_DISTRIBUTION_HARNESSES.includes(match[1])) continue;
    const harnessFiles = byHarness.get(match[1]) ?? new Map();
    harnessFiles.set(
      safeDistributionPath(match[2]),
      Buffer.isBuffer(body) ? body : Buffer.from(body),
    );
    byHarness.set(match[1], harnessFiles);
  }
  return byHarness;
};

const fileManifest = (files) =>
  [...files]
    .map(([path, body]) => ({ path, bytes: body.length, sha256: sha256(body) }))
    .toSorted((a, b) => a.path.localeCompare(b.path));

const isMissing = (error) =>
  error?.name === 'NoSuchKey' ||
  error?.name === 'NotFound' ||
  [403, 404].includes(error?.$metadata?.httpStatusCode);
const isPreconditionFailed = (error) =>
  error?.name === 'PreconditionFailed' || error?.$metadata?.httpStatusCode === 412;

const readJsonIfPresent = async ({ s3, bucket, key }) => {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await result.Body.transformToString());
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

const sameFiles = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Stores each harness distribution the fork ships. Idempotent: a harness whose
 * manifest already records the same files is left alone, and one that records
 * different files is a conflict (the release SHA is immutable, so its bytes
 * cannot legitimately change). Returns the harnesses now available.
 */
const publishReleaseDistributions = async ({ s3, bucket, keyArgs, files }) => {
  const results = [];
  for (const [harness, harnessFiles] of splitReleaseDistributions(files)) {
    const keys = releaseDistributionKeys(keyArgs, harness);
    const filesRecord = fileManifest(harnessFiles);
    const existing = await readJsonIfPresent({ s3, bucket, key: keys.manifest });
    if (existing) {
      if (!sameFiles(existing.files, filesRecord)) {
        throw new Error(
          `release-distributions: ${keys.manifest} already records different ${harness} files`,
        );
      }
      results.push({ harness, status: 'already-published', files: filesRecord.length });
      continue;
    }
    const archive = await buildDistributionArchive(harnessFiles);
    // The archive is not the marker, so a partial earlier write may be replaced.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keys.archive,
        Body: archive,
        ContentType: 'application/gzip',
      }),
    );
    const manifest = {
      schemaVersion: 1,
      ref: keyArgs.sha,
      harness,
      archive: `${harness}.tar.gz`,
      archiveBytes: archive.length,
      archiveSha256: sha256(archive),
      files: filesRecord,
    };
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keys.manifest,
          Body: `${JSON.stringify(manifest, null, 2)}\n`,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      // A concurrent import won the marker; it must describe the same files.
      const raced = await readJsonIfPresent({ s3, bucket, key: keys.manifest });
      if (!raced || !sameFiles(raced.files, filesRecord)) {
        throw new Error(
          `release-distributions: ${keys.manifest} was written concurrently with different ${harness} files`,
          { cause: error },
        );
      }
    }
    results.push({ harness, status: 'published', files: filesRecord.length });
  }
  return results.toSorted((a, b) => a.harness.localeCompare(b.harness));
};

export {
  NATIVE_DISTRIBUTION_HARNESSES,
  publishReleaseDistributions,
  releaseDistributionKeys,
  splitReleaseDistributions,
};
export default {
  NATIVE_DISTRIBUTION_HARNESSES,
  publishReleaseDistributions,
  releaseDistributionKeys,
  splitReleaseDistributions,
};
