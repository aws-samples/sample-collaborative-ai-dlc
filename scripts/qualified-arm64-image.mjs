import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
function requireMatch(matches, description) {
  if (!matches) throw new Error(`ARM64 qualification mismatch: ${description}`);
}
function readBoundJson(path, sha256) {
  const bytes = readFileSync(path);
  requireMatch(hash(bytes) === sha256, path);
  return JSON.parse(bytes);
}

// The operator pins the installed qualification receipt in the environment's
// deployment configuration. Bind that receipt to this checkout and to the OCI
// bytes captured by the qualifier before exposing an image ID to Terraform.
function qualifiedImage({ receipt, sha256, source_path, source_sha, source_tag }) {
  const q = readBoundJson(receipt, sha256);
  const { build, image } = q;
  requireMatch(
    q.status === 'PASS_LOCAL_INSTALLED_ARM64' &&
      build.exitCode === 0 &&
      build.installed.status === 'passed' &&
      q.qualification.installedMatrix === 'passed' &&
      image.platform === 'linux/arm64' &&
      build.observedCommit === q.sourceCommit &&
      build.installed.sourceCommit === q.sourceCommit &&
      /^[a-f0-9]{40}$/.test(q.sourceCommit),
    'installed qualification',
  );
  const directory = dirname(receipt);
  const manifest = readBoundJson(
    join(directory, 'image-qualification/runtime-source-manifest.json'),
    build.manifestSha256,
  );
  requireMatch(
    manifest.commit === q.sourceCommit &&
      manifest.platform === image.platform &&
      manifest.builder === 'default' &&
      isDeepStrictEqual(manifest.buildArgs, build.args) &&
      manifest.sourceTag === source_tag &&
      build.sourceTag === source_tag &&
      manifest.runtimeSourceSha1 === source_sha &&
      build.runtimeSourceSha1 === source_sha &&
      build.installed.runtimeSource === source_sha &&
      manifest.runtimeFiles.length === build.installed.files,
    'checkout, source tag or installed source manifest',
  );
  const root = dirname(source_path);
  const fileHashes = manifest.runtimeFiles.map(({ path, bytes, mode, sha256: fileHash }) => {
    requireMatch(
      /^lambda\/(?:agentcore|shared|native-runtime-control)\//.test(path) &&
        !path.split('/').includes('..'),
      'runtime file path',
    );
    const file = join(root, path);
    const stat = lstatSync(file);
    requireMatch(stat.isFile(), path);
    const content = readFileSync(file);
    requireMatch(
      content.length === bytes && hash(content) === fileHash && (stat.mode & 0o777) === mode,
      path,
    );
    return hash(content, 'sha1');
  });
  requireMatch(hash(fileHashes.join(''), 'sha1') === source_sha, 'runtime files');
  // The context ignore file and its three included harness files sit outside
  // the historical Terraform source-tag set. The image copies these too.
  requireMatch(
    hash(readFileSync(join(source_path, '.dockerignore'))) === build.inputs['lambda/.dockerignore'],
    'Docker context exclusions',
  );
  const harnessFiles = [
    'lambda/agentcore/test/local-e2e-config.js',
    'lambda/agentcore/test/local-e2e-harness.mjs',
    'lambda/agentcore/test/helpers/v2-table.js',
  ];
  const entries = execFileSync(
    'git',
    [
      'ls-tree',
      '--full-tree',
      q.sourceCommit,
      '--',
      ...harnessFiles.map((file) => `:(top)${file}`),
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  requireMatch(entries.length === harnessFiles.length, 'qualified harness tree');
  for (const entry of entries) {
    const [mode, type, blob, file] = entry.split(/\s+/);
    const path = join(root, file);
    const stat = lstatSync(path);
    requireMatch(stat.isFile(), file);
    const bytes = readFileSync(path);
    const blobId = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    requireMatch(
      type === 'blob' && blob === blobId && mode === (stat.mode & 0o111 ? '100755' : '100644'),
      file,
    );
  }
  const metadata = readBoundJson(
    join(directory, 'image-qualification/build/metadata.json'),
    build.buildkitMetadataSha256,
  );
  requireMatch(metadata['containerimage.digest'] === image.localImageId, 'BuildKit output index');
  const readOci = (file, digest) => {
    requireMatch(/^sha256:[a-f0-9]{64}$/.test(digest), file);
    return readBoundJson(join(directory, 'oci-identity', file), digest.slice(7));
  };
  const index = readOci('qualified-index.json', image.localImageId);
  const arm64 = index.manifests.filter(
    (m) => m.platform?.os === 'linux' && m.platform.architecture === 'arm64',
  );
  requireMatch(
    arm64.length === 1 && arm64[0].digest === image.platformManifestDigest,
    'ARM64 platform in index',
  );
  const platform = readOci('qualified-platform-manifest.json', image.platformManifestDigest);
  requireMatch(platform.config.digest === image.configDigest, 'platform configuration');
  const config = readOci('qualified-config.json', image.configDigest);
  requireMatch(
    config.os === 'linux' &&
      config.architecture === 'arm64' &&
      image.tag.endsWith(`:${source_tag}`),
    'local qualified tag or platform',
  );
  return { tag: image.tag, index: image.localImageId, arm64: image.platformManifestDigest };
}

try {
  console.log(JSON.stringify(qualifiedImage(JSON.parse(readFileSync(0, 'utf8')))));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
