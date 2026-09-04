import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_COMMAND,
  PROTECTED_RUNTIME_MANIFEST,
  PROTECTED_RUNTIME_PATHS,
  PROTECTED_VARIABLE_NAME,
  SECRET_COMMAND,
  SECRET_NAME,
  SECRET_VALUE,
  protectedManifestLine,
  protectedRuntimeEpilogueLines,
  verificationEpilogue,
  verificationPrologue,
} from '../build-guardrails.js';

const source = (name) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

// The guardrails are security controls shared by every authoring path. A private
// copy in one engine is how a future hardening silently misses the others, so the
// drift guard is a source-level assertion, not just a behavioural one.
const CONSUMERS = ['fixed-tool-recipe.js', 'catalog-recipe.js', 'tool-catalog.js'];
const DENYLISTS = [
  'SECRET_NAME',
  'SECRET_VALUE',
  'SECRET_COMMAND',
  'PROTECTED_VARIABLE_NAME',
  'FORBIDDEN_COMMAND',
];

describe('shared build guardrails', () => {
  it.each(CONSUMERS)('%s declares no private denylist copy', (name) => {
    const contents = source(name);
    for (const denylist of DENYLISTS) {
      expect(contents).not.toMatch(new RegExp(`^\\s*const ${denylist}\\s*=`, 'm'));
    }
    expect(contents).toContain("from './build-guardrails.js'");
  });

  it.each(CONSUMERS)('%s does not inline the protected-runtime paths', (name) => {
    // Catches a copy of the manifest or diff commands drifting away from the
    // shared primitives that both engines emit.
    expect(source(name)).not.toContain('/opt/agentcore /opt/shared');
  });

  it('keeps one definition of the protected runtime boundary', () => {
    expect(PROTECTED_RUNTIME_PATHS).toEqual(['agentcore', 'shared']);
    expect(PROTECTED_RUNTIME_MANIFEST).toBe('/opt/managed/protected-runtime.sha256');
    expect(protectedManifestLine()).toBe(
      'RUN find /opt/agentcore /opt/shared -type f -print0 | sort -z | xargs -0 sha256sum > /opt/managed/protected-runtime.sha256',
    );
  });

  it('restores the non-root image contract after administrator build commands', () => {
    expect(protectedRuntimeEpilogueLines()).toEqual([
      'RUN sha256sum -c /opt/managed/protected-runtime.sha256',
      'USER node',
      'WORKDIR /mnt/workspace',
      'EXPOSE 8080',
      'ENTRYPOINT ["node", "/opt/agentcore/http-server.js"]',
      'CMD []',
    ]);
  });

  it('diffs every protected tree against the pinned base outside the build', () => {
    const prologue = verificationPrologue();
    expect(prologue).toContain(
      'base_ref="$(jq -r \'.base.imageUri + "@" + .base.imageDigest\' manifest.json)"',
    );
    expect(prologue).toContain('for path in agentcore shared; do');
    expect(prologue).toContain(
      'diff -qr --no-dereference "$protected_dir/base-$path" "$protected_dir/built-$path"',
    );
    expect(prologue).toContain(`sha256sum -c ${PROTECTED_RUNTIME_MANIFEST}`);
    expect(verificationEpilogue()).toContain('"runtimeFiles":"PASS"');
  });

  it('blocks secret-like variables, values, and build commands', () => {
    expect(SECRET_NAME.test('BUILD_TOKEN')).toBe(true);
    expect(SECRET_NAME.test('BUILD_MODE')).toBe(false);
    expect(SECRET_VALUE.test(`AKIA${'A'.repeat(16)}`)).toBe(true);
    expect(SECRET_COMMAND.test('export API_KEY=abc')).toBe(true);
    expect(SECRET_COMMAND.test('printf verified')).toBe(false);
  });

  it('reserves platform-owned variables and protected-path commands', () => {
    expect(PROTECTED_VARIABLE_NAME.test('AWS_REGION')).toBe(true);
    expect(PROTECTED_VARIABLE_NAME.test('PATH')).toBe(true);
    expect(PROTECTED_VARIABLE_NAME.test('BUILD_MODE')).toBe(false);
    expect(FORBIDDEN_COMMAND.test('chmod 0777 /opt/agentcore')).toBe(true);
    expect(FORBIDDEN_COMMAND.test('USER root')).toBe(true);
    expect(FORBIDDEN_COMMAND.test('printf verified')).toBe(false);
  });
});
