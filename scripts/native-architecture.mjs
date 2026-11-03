#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  analyzeArchitectureSource,
  checkArchitecture,
  nativeArchitectureScope,
  productionSource,
} from './lib/native-architecture.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32e6 }).trim();
const manifest = JSON.parse(readFileSync('architecture/native-owners.json', 'utf8'));
const baselinePath = 'architecture/native-complexity-baseline.json';
const baselineRef = process.argv.includes('--baseline');
if (baselineRef) {
  const ref = '8065b4c3f6c496d4e63bc11ff0909fb0450d845b';
  const files = git('ls-tree', '-r', '--name-only', ref, '--', 'lambda')
    .split('\n')
    .filter(productionSource)
    .filter(nativeArchitectureScope);
  const functions = files
    .flatMap((file) => analyzeArchitectureSource(file, git('show', `${ref}:${file}`)).functions)
    .filter((fn) => fn.score > 20);
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        ref,
        metric:
          '1 + if + ternary + loops + non-default switch case + catch; nearest function; no logical operators',
        parser: 'acorn 8.18.0',
        functions: Object.fromEntries(functions.map((fn) => [fn.key, fn.score])),
      },
      null,
      2,
    ) + '\n',
  );
} else {
  const paths = git('ls-files', '--cached', '--others', '--exclude-standard', '--', 'lambda')
    .split('\n')
    .filter(productionSource);
  const files = [...new Set(paths)].map((file) =>
    analyzeArchitectureSource(file, readFileSync(file, 'utf8')),
  );
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const errors = checkArchitecture(files, manifest, baseline);
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  if (process.argv.includes('--map')) {
    const dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
    if (dirty && !process.argv.includes('--allow-dirty'))
      throw new Error('Release architecture map requires one clean HEAD');
    const head = git('rev-parse', 'HEAD');
    const iamSources = git(
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'terraform/modules/compute/native-runs',
      'terraform/modules/api/lambda/main.tf',
      'terraform/modules/compute/agentcore/main.tf',
    )
      .split('\n')
      .filter((file) => file.endsWith('.tf'))
      .map((file) => {
        const source = readFileSync(file, 'utf8');
        return {
          file,
          sha256: createHash('sha256').update(source).digest('hex'),
          roles: [...source.matchAll(/resource "aws_iam_role(?:_policy)?" "([^"]+)"/g)].map(
            (m) => m[1],
          ),
          // These are source declarations, not an effective-policy simulation.
          declaredActions: [
            ...new Set(
              [...source.matchAll(/"(dynamodb|lambda|neptune-db|s3|sqs):([A-Za-z*]+)"/g)].map(
                (m) => `${m[1]}:${m[2]}`,
              ),
            ),
          ].toSorted(),
        };
      });
    const map = {
      schemaVersion: 1,
      head,
      dirty,
      node: process.version,
      metric: baseline.metric,
      owners: manifest,
      iamSources,
      files,
      limitations: [
        'Dynamic edges are listed, not executed',
        'Graph and filesystem ownership is declared and reviewed; direct SDK sites are statically measured',
      ],
    };
    mkdirSync('reports/architecture', { recursive: true });
    writeFileSync('reports/architecture/native.json', JSON.stringify(map, null, 2) + '\n');
    const escape = (s) =>
      String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const hotspots = files
      .filter((f) => nativeArchitectureScope(f.file))
      .flatMap((f) => f.functions.map((fn) => ({ file: f.file, ...fn })))
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 30);
    writeFileSync(
      'reports/architecture/native.html',
      `<!doctype html><meta charset="utf-8"><title>Native architecture</title><style>body{font:16px system-ui;max-width:1100px;margin:3rem auto}td,th{padding:.5rem;text-align:left;vertical-align:top}pre{white-space:pre-wrap}</style><h1>Native architecture</h1><p>HEAD ${head}${dirty ? ' (working tree preview)' : ''}</p><p>${escape(baseline.metric)}</p><h2>Owners and boundaries</h2><pre>${escape(JSON.stringify(manifest.records, null, 2))}</pre><h2>Measured hotspots</h2><table>${hotspots.map((fn) => `<tr><td>${escape(fn.file)}:${fn.line}</td><td>${escape(fn.name)}</td><td>${fn.score}</td></tr>`).join('')}</table><p>Machine-readable imports, direct write sites, unresolved dynamic edges accompany this artifact.</p>`,
    );
  }
  console.log(
    `Architecture checked: ${files.length} production modules, ${errors.length} violations`,
  );
}
