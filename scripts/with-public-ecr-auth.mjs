#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// kreuzwerker/docker 3.9.0 initializes a Docker CLI for Buildx independently of
// provider registry_auth. BuildKit's auth session reads this CLI's DOCKER_CONFIG.
const registry = 'public.ecr.aws';
const [root, separator, command, ...args] = process.argv.slice(2);
if (!root || separator !== '--' || !command) {
  console.error('Usage: with-public-ecr-auth.mjs <deployment-checkout> -- <command> [args...]');
  process.exit(2);
}

let configDirectory;
let child;
let interrupted = false;
const processGroup = process.platform !== 'win32';
const cleanup = () => {
  if (configDirectory) rmSync(configDirectory, { recursive: true, force: true });
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    if (!child) process.exit(signal === 'SIGINT' ? 130 : 143);
    try {
      // Include the deploy shell's Terraform child when cancelling an apply.
      if (processGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}

try {
  const images = new Set();
  for (const dockerfile of ['lambda/agentcore/Dockerfile', 'lambda/yjs-server/Dockerfile']) {
    const contents = readFileSync(resolve(root, dockerfile), 'utf8');
    for (const match of contents.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)) {
      if (match[1].startsWith(`${registry}/`)) images.add(match[1]);
    }
  }
  // Releases predating the Public ECR bases need no additional authentication.
  if (images.size > 0) {
    if (
      process.env.DOCKER_BUILDKIT &&
      !['1', 't', 'T', 'true', 'True', 'TRUE'].includes(process.env.DOCKER_BUILDKIT)
    ) {
      throw new Error(
        'Public ECR authentication requires BuildKit; unset DOCKER_BUILDKIT or set it to 1.',
      );
    }
    const sourceDirectory = resolve(process.env.DOCKER_CONFIG || join(homedir(), '.docker'));
    let config = {};
    try {
      config = JSON.parse(readFileSync(join(sourceDirectory, 'config.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error('Cannot read the existing Docker config.json.', { cause: error });
      }
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Docker config.json must contain an object.');
    }

    const login = spawnSync(
      'aws',
      [
        'ecr-public',
        'get-authorization-token',
        '--region',
        'us-east-1',
        '--query',
        'authorizationData.authorizationToken',
        '--output',
        'text',
      ],
      { encoding: 'utf8', env: { ...process.env, AWS_PAGER: '' }, timeout: 60_000 },
    );
    if (login.error || login.status !== 0) {
      // Do not echo subprocess output: authentication output can contain secrets.
      throw new Error(
        'Public ECR login failed. The deployment identity needs ecr-public:GetAuthorizationToken and sts:GetServiceBearerToken in us-east-1. Check AWS credentials and network access.',
      );
    }
    const token = login.stdout.trim();
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (
      !decoded.startsWith('AWS:') ||
      decoded.length <= 4 ||
      Buffer.from(decoded).toString('base64') !== token
    ) {
      throw new Error('Public ECR returned an invalid authorization token.');
    }

    configDirectory = mkdtempSync(join(tmpdir(), 'aidlc-public-ecr-'));
    // Keep existing contexts, plugins and Buildx state available without copying
    // or modifying the caller's registry config or credential store.
    let entries = [];
    try {
      entries = readdirSync(sourceDirectory);
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Cannot read the existing Docker config directory.', { cause: error });
    }
    for (const entry of entries) {
      if (entry !== 'config.json') {
        symlinkSync(join(sourceDirectory, entry), join(configDirectory, entry));
      }
    }
    config.auths = { ...config.auths, [registry]: { auth: token } };
    // An explicit empty helper selects the file store for this registry, even
    // when a global credsStore (e.g. desktop/osxkeychain) is configured.
    config.credHelpers = { ...config.credHelpers, [registry]: '' };
    writeFileSync(join(configDirectory, 'config.json'), `${JSON.stringify(config)}\n`, {
      mode: 0o600,
    });

    // Use the same stored token as BuildKit. This checks manifest access, not
    // layer downloads, platform execution, or the builder's network/cache.
    const storedToken = JSON.parse(readFileSync(join(configDirectory, 'config.json'), 'utf8'))
      .auths[registry].auth;
    for (const image of images) {
      const match = image.match(
        /^public\.ecr\.aws\/([a-z0-9._/-]+)(?::([\w.-]+))?(?:@(sha256:[a-f0-9]{64}))?$/,
      );
      if (!match) throw new Error(`Expected a literal Public ECR base: ${image}`);
      // Preserve tag-only bases in older releases (for example v2.0.0).
      // When both are present Docker resolves the digest, not the tag.
      const reference = match[3] || match[2] || 'latest';
      const response = spawnSync(
        'curl',
        [
          '-q',
          '--silent',
          '--fail',
          '--connect-timeout',
          '10',
          '--max-time',
          '60',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          '--config',
          '-',
          `https://${registry}/v2/${match[1]}/manifests/${reference}`,
        ],
        {
          encoding: 'utf8',
          // stdin keeps the token out of argv, environment and shell tracing.
          input: `header = "Authorization: Bearer ${storedToken}"\nheader = "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"\n`,
          timeout: 65_000,
        },
      );
      if (response.error || response.status !== 0 || response.stdout !== '200') {
        const status = /^\d{3}$/.test(response.stdout) ? response.stdout : 'unavailable';
        throw new Error(
          `Public ECR manifest check failed for ${image} (HTTP ${status}); apply has not started.`,
        );
      }
    }
    console.log(
      `Authenticated Public ECR manifest access verified for ${images.size} base images.`,
    );
  }

  child = spawn(command, args, {
    stdio: 'inherit',
    detached: processGroup,
    env: {
      ...process.env,
      ...(configDirectory ? { DOCKER_CONFIG: configDirectory } : {}),
      AIDLC_PUBLIC_ECR_AUTH_WRAPPED: '1',
    },
  });
  child.on('error', () => {
    console.error('Could not start the authenticated deployment command.');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
    if (interrupted && process.exitCode === 0) process.exitCode = 143;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
