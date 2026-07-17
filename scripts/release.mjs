#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const semverCore = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const semverBuildIdentifier = /^[0-9A-Za-z-]+$/;
const semverPrereleaseIdentifier = /^(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)$/;

const isStrictSemver = (version) => {
  if (typeof version !== 'string' || version.length === 0) return false;

  const plusIndex = version.indexOf('+');
  const mainAndPre = plusIndex === -1 ? version : version.slice(0, plusIndex);
  const build = plusIndex === -1 ? '' : version.slice(plusIndex + 1);
  if (plusIndex !== -1) {
    if (build.length === 0) return false;
    const buildIdentifiers = build.split('.');
    if (buildIdentifiers.some((id) => !semverBuildIdentifier.test(id))) return false;
  }

  const dashIndex = mainAndPre.indexOf('-');
  const core = dashIndex === -1 ? mainAndPre : mainAndPre.slice(0, dashIndex);
  const prerelease = dashIndex === -1 ? '' : mainAndPre.slice(dashIndex + 1);

  if (!semverCore.test(core)) return false;
  if (dashIndex === -1) return true;
  if (prerelease.length === 0) return false;

  const prereleaseIdentifiers = prerelease.split('.');
  return prereleaseIdentifiers.every((id) => semverPrereleaseIdentifier.test(id));
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const componentManifests = (dir = root) => {
  const ignored = new Set(['.git', '.terraform', 'builds', 'dist', 'node_modules', 'site']);
  const manifests = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) manifests.push(...componentManifests(path));
    if (entry.isFile() && entry.name === 'package.json' && path !== join(root, 'package.json')) {
      manifests.push(path);
    }
  }
  return manifests.toSorted();
};

const changelogHeading = (version) =>
  new RegExp(`^## \\[${escapeRegExp(version)}\\] - (TBD|\\d{4}-\\d{2}-\\d{2})$`, 'm');

const validate = (expectedVersion, flags) => {
  const errors = [];
  const pkg = readJson(join(root, 'package.json'));
  const lock = readJson(join(root, 'package-lock.json'));
  const version = expectedVersion || pkg.version;

  if (!isStrictSemver(version || ''))
    errors.push(`Invalid strict SemVer: ${version || '(missing)'}`);
  if (pkg.version !== version) {
    errors.push(`package.json version ${pkg.version} does not match expected ${version}`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    errors.push('package-lock.json root versions do not match package.json');
  }

  for (const path of componentManifests()) {
    const manifest = readJson(path);
    const label = relative(root, path);
    if (Object.hasOwn(manifest, 'version')) errors.push(`${label} must not define a version`);
    if (manifest.private !== true) errors.push(`${label} must set private: true`);
  }

  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const match = changelog.match(changelogHeading(version));
  if (!match) errors.push(`CHANGELOG.md needs "## [${version}] - TBD" or an ISO release date`);
  if (match?.[1] !== 'TBD') {
    const date = new Date(`${match[1]}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) {
      errors.push(`CHANGELOG.md release ${version} has an invalid date: ${match[1]}`);
    }
  }
  if (flags.has('--final') && match?.[1] === 'TBD') {
    errors.push(`CHANGELOG.md release ${version} still has a TBD date`);
  }

  if (flags.has('--tag-must-not-exist')) {
    const tag = `v${version}`;
    const tags = execFileSync('git', ['tag', '--list', tag], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (tags) errors.push(`Tag ${tag} already exists; release tags are immutable`);
  }

  if (errors.length) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exit(1);
  }
  console.log(`Release metadata is valid for ${version}${flags.has('--final') ? ' (final)' : ''}.`);
};

const prepare = (version) => {
  if (!isStrictSemver(version || '')) {
    throw new Error('Usage: npm run release:prepare -- <strict-semver>');
  }
  const pkgPath = join(root, 'package.json');
  const lockPath = join(root, 'package-lock.json');
  const pkg = readJson(pkgPath);
  const lock = readJson(lockPath);
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  writeJson(pkgPath, pkg);
  writeJson(lockPath, lock);

  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  if (!changelogHeading(version).test(changelog)) {
    const coreVersion = version.split(/[+-]/, 1)[0];
    const priorPrereleaseHeading = new RegExp(
      `^## \\[${escapeRegExp(coreVersion)}-[0-9A-Za-z.-]+\\] - (?:TBD|\\d{4}-\\d{2}-\\d{2})$`,
      'm',
    );
    const marker = '## [Unreleased]';
    const next = priorPrereleaseHeading.test(changelog)
      ? changelog.replace(priorPrereleaseHeading, `## [${version}] - TBD`)
      : changelog.replace(marker, `${marker}\n\n## [${version}] - TBD`);
    if (next === changelog) throw new Error(`Could not find ${marker} in CHANGELOG.md`);
    writeFileSync(changelogPath, next);
  }
  console.log(`Prepared ${version}. Complete the changelog before release.`);
};

const [command, version, ...rest] = process.argv.slice(2);
if (command === 'prepare') prepare(version);
else if (command === 'check') validate(version, new Set(rest));
else {
  console.error('Usage: release.mjs <prepare|check> [version] [--final] [--tag-must-not-exist]');
  process.exit(2);
}
