#!/usr/bin/env node

// Single place to manage the @aws-sdk/* version range.
//
// The same `^3.x.y` range is declared in the root package.json and in ~20
// lambda/*/package.json workspace files. This script keeps them in lockstep:
//
//   node scripts/sync-aws-sdk.mjs            # align everything to the root's range
//   node scripts/sync-aws-sdk.mjs 3.1100.0   # set ^3.1100.0 everywhere
//   node scripts/sync-aws-sdk.mjs --check    # exit 1 if any file drifts from root
//
// After a bump, run `npm install` to refresh package-lock.json.
// Only @aws-sdk/* is synced. Other shared deps (@smithy/*, gremlin, ...) are
// left alone — e.g. lambda/agents deliberately pins @smithy/node-config-provider
// to a different major than the root — but drift in them is reported as a warning.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const checkOnly = arg === '--check';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const rootPkg = readJson(join(root, 'package.json'));
const rootRanges = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
const rootSdkRanges = Object.values(
  Object.fromEntries(Object.entries(rootRanges).filter(([name]) => name.startsWith('@aws-sdk/'))),
);
if (new Set(rootSdkRanges).size > 1) {
  console.error(
    `root package.json has mixed @aws-sdk/* ranges: ${[...new Set(rootSdkRanges)].join(', ')}`,
  );
  process.exit(1);
}

let targetRange;
if (arg && !checkOnly) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`expected a plain version like 3.1100.0, got: ${arg}`);
    process.exit(1);
  }
  targetRange = `^${arg}`;
} else {
  targetRange = rootSdkRanges[0];
}

const packageFiles = [
  join(root, 'package.json'),
  join(root, 'frontend', 'package.json'),
  ...readdirSync(join(root, 'lambda'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'lambda', entry.name, 'package.json')),
];

let drift = false;
let changedFiles = 0;

for (const file of packageFiles) {
  let pkg;
  try {
    pkg = readJson(file);
  } catch {
    continue; // lambda dir without a package.json
  }
  const rel = relative(root, file);
  let changed = false;

  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith('@aws-sdk/')) {
        if (range !== targetRange) {
          drift = true;
          if (checkOnly) {
            console.error(`${rel}: ${name} is ${range}, expected ${targetRange}`);
          } else {
            pkg[section][name] = targetRange;
            changed = true;
          }
        }
      } else if (
        name in rootRanges &&
        rootRanges[name] !== range &&
        file !== join(root, 'package.json')
      ) {
        console.warn(
          `warning: ${rel}: ${name} is ${range} but root declares ${rootRanges[name]} (not synced)`,
        );
      }
    }
  }

  if (changed) {
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
    changedFiles += 1;
    console.log(`updated ${rel}`);
  }
}

if (checkOnly) {
  if (drift) process.exit(1);
  console.log(`ok: all @aws-sdk/* ranges are ${targetRange}`);
} else if (changedFiles > 0) {
  console.log(
    `\nset @aws-sdk/* to ${targetRange} in ${changedFiles} file(s). Now run: npm install`,
  );
} else {
  console.log(`nothing to do: all @aws-sdk/* ranges are already ${targetRange}`);
}
