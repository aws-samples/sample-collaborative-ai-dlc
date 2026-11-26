#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  NativePackageError,
  verifyNativeReleaseDirectory,
} from '../lambda/shared/native-runtime-package.js';

const usage = `Verify an already-downloaded native AI-DLC release without executing it.

node scripts/verify-native-release.mjs --directory DIR --repository OWNER/REPO \\
  --release TAG --commit SHA [--provider github|gitlab|bitbucket]

DIR must contain version.json, checksums.txt, the Linux ARM64 binary and native
runtime archive. The JSON report records integrity and projection checks only;
it does not qualify signatures, human approval behavior, or harness execution.
`;

try {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      provider: { type: 'string', default: 'github' },
      repository: { type: 'string' },
      release: { type: 'string' },
      commit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    if (!values.directory || !values.repository || !values.release || !values.commit) {
      throw new NativePackageError('directory, repository, release and commit are required');
    }
    const result = await verifyNativeReleaseDirectory({
      directory: values.directory,
      source: {
        provider: values.provider,
        repository: values.repository,
        release: values.release,
        commit: values.commit,
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  // Provider/source credentials are never inputs. Hide filesystem parser errors
  // while preserving the verifier's bounded, actionable error messages.
  const safe = ['NativePackageError', 'NativeReleaseValidationError'].includes(error?.name);
  process.stderr.write(`${safe ? error.message : 'Unable to verify native release'}\n`);
  process.exitCode = 1;
}
