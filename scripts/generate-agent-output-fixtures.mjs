#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliOutputSink } from '../lambda/agentcore/output-normalizer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = path.join(root, 'lambda', 'agentcore', 'test', 'fixtures', 'agent-output');
const outputFile = path.join(root, 'frontend', 'public', 'dev', 'agent-output-fixtures.json');
const cliFiles = {
  claude: 'claude.jsonl',
  kiro: 'kiro.txt',
  opencode: 'opencode.jsonl',
};
const cliLabels = {
  claude: 'Claude Code',
  kiro: 'Kiro CLI',
  opencode: 'OpenCode',
};

const reportsFlag = process.argv.indexOf('--reports');
const reportsDir =
  reportsFlag >= 0 && process.argv[reportsFlag + 1]
    ? path.resolve(process.argv[reportsFlag + 1])
    : null;

const fixtureRows = async (cli, filename, cliIndex) => {
  const raw = await readFile(path.join(rawDir, filename), 'utf8');
  const rows = [];
  const baseTime = Date.parse('2026-07-16T12:34:00.000Z') + cliIndex * 60_000;
  const sink = createCliOutputSink({
    cli,
    emit: ({ content, display }) => {
      const seq = rows.length + 1;
      rows.push({
        seq,
        stageInstanceId: `preview-${cli}`,
        kind: 'stdout',
        content,
        timestamp: new Date(baseTime + seq * 7_000).toISOString(),
        ...(display ? { display } : {}),
      });
    },
  });
  sink.write(raw);
  sink.flush();
  return { cli, label: cliLabels[cli], source: 'fixture', raw, rows };
};

const reportAgents = async () => {
  if (!reportsDir) return new Map();
  const names = await readdir(reportsDir).catch(() => []);
  const agents = new Map();
  for (const cli of Object.keys(cliFiles)) {
    const filename = names.find((name) => name === `${cli}.json`);
    if (!filename) continue;
    try {
      const report = JSON.parse(await readFile(path.join(reportsDir, filename), 'utf8'));
      const rows = Array.isArray(report.outputs) ? report.outputs : [];
      agents.set(cli, {
        cli,
        label: cliLabels[cli],
        source: 'local E2E',
        raw: rows.map((row) => row.content ?? '').join(''),
        rows,
      });
    } catch (error) {
      process.stderr.write(`Skipping ${filename}: ${error.message}\n`);
    }
  }
  return agents;
};

const reports = await reportAgents();
const agents = await Promise.all(
  Object.entries(cliFiles).map(async ([cli, filename], index) => {
    return reports.get(cli) ?? fixtureRows(cli, filename, index);
  }),
);

await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(
  outputFile,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      reportsDir,
      agents,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
process.stdout.write(`${outputFile}\n`);
