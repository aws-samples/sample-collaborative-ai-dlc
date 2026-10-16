#!/usr/bin/env node
// Manual diagnostic only. All AWS clients reject non-read commands. No repair,
// model call, provider request, scan, or scheduled account-wide discovery.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import { createProcessStore } from '../lambda/shared/v2-process-store.js';
import { createIntentMethodologyLoader } from '../lambda/shared/intent-methodology.js';
import {
  auditCompletion,
  validateCompletionAuditScope,
} from '../lambda/shared/completion-audit.js';

export const readBudget = (maxRequests) => {
  let requests = 0;
  return (client) => ({
    send(command) {
      if (
        !['GetCommand', 'QueryCommand', 'BatchGetCommand', 'GetObjectCommand'].includes(
          command.constructor.name,
        )
      ) {
        throw new Error('Completion audit allows targeted reads only');
      }
      if (++requests > maxRequests) throw new Error('Completion audit request limit reached');
      return client.send(command);
    },
  });
};

export const main = async (args = process.argv.slice(2)) => {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean' },
      ...Object.fromEntries(
        [
          'project',
          'from',
          'to',
          'status',
          'limit',
          'page-size',
          'max-pages',
          'record-limit',
          'max-requests',
          'checkpoint',
          'output',
          'fixture',
          'table',
          'blocks-table',
          'artifacts-bucket',
          'region',
          'profile',
        ].map((key) => [key, { type: 'string' }]),
      ),
    },
  });
  if (values.help) {
    process.stdout.write(
      [
        'Read-only completion audit. No repairs, provider calls or model calls.',
        'Required: --project ID --from ISO_UTC --to ISO_UTC (execution start time, [from,to)).',
        'Live: --region REGION --table PROCESS_TABLE --blocks-table BLOCKS_TABLE',
        '      [--profile READ_PROFILE] [--artifacts-bucket BUCKET]',
        'Offline: --fixture FILE',
        'Bounds: --status SUCCEEDED|FAILED|CANCELLED --limit 100 --page-size 25',
        '        --max-pages 10 --record-limit 2000 --max-requests 5000',
        'Output: JSONL stdout, or --output FILE. Resume: --checkpoint FILE.',
        'Exit: 0 finished, 2 incomplete/unverified/error, 3 more pages.',
        '',
      ].join('\n'),
    );
    return 0;
  }
  const scope = validateCompletionAuditScope({
    projectId: values.project,
    from: values.from,
    to: values.to,
    status: values.status ?? 'SUCCEEDED',
    maxExecutions: Number(values.limit ?? 100),
    pageSize: Number(values['page-size'] ?? 25),
    maxPages: Number(values['max-pages'] ?? 10),
    maxRecordsPerExecution: Number(values['record-limit'] ?? 2000),
  });
  let checkpoint = null;
  const source = values.fixture
    ? { fixture: resolve(values.fixture) }
    : {
        region: values.region,
        table: values.table,
        blocksTable: values['blocks-table'],
        artifactsBucket: values['artifacts-bucket'] ?? null,
      };
  if (values.checkpoint) {
    try {
      const saved = JSON.parse(await readFile(values.checkpoint, 'utf8'));
      if (saved && JSON.stringify(saved.source) !== JSON.stringify(source)) {
        throw new Error('Completion audit checkpoint source differs');
      }
      checkpoint = saved?.audit ?? null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let store;
  let loadPlan;
  if (values.fixture) {
    const fixtures = JSON.parse(await readFile(values.fixture, 'utf8'));
    const selected = fixtures.filter(
      ({ records: { meta } }) =>
        meta.projectId === scope.projectId &&
        meta.status === scope.status &&
        meta.startedAt >= scope.from &&
        meta.startedAt < scope.to,
    );
    const fixtureFor = (id) => fixtures.find((f) => f.records.meta.executionId === id);
    store = {
      listCompletionAuditPage: async ({ cursor, limit }) => {
        const offset = cursor?.offset ?? 0;
        return {
          items: selected.slice(offset, offset + limit).map((f) => f.records.meta),
          cursor: offset + limit < selected.length ? { offset: offset + limit } : null,
        };
      },
      getCompletionRecords: async (id) => fixtureFor(id).records,
      getExecution: async (id) => fixtureFor(id).records.meta,
      getUnitPlan: async (id) => fixtureFor(id).records.unitPlan ?? null,
    };
    loadPlan = async (meta) => fixtureFor(meta.executionId).planResult;
  } else {
    if (!values.table || !values['blocks-table'] || !values.region) {
      throw new Error('Live reads require explicit --table, --blocks-table and --region');
    }
    const maxRequests = Number(values['max-requests'] ?? 5000);
    if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000) {
      throw new Error('--max-requests must be 1..10000');
    }
    const options = {
      region: values.region,
      maxAttempts: 2,
      ...(values.profile ? { credentials: fromIni({ profile: values.profile }) } : {}),
    };
    const bound = readBudget(maxRequests);
    const ddb = bound(DynamoDBDocumentClient.from(new DynamoDBClient(options)));
    const s3 = bound(new S3Client(options));
    store = createProcessStore({ ddb, tableName: values.table });
    ({ loadPlan } = createIntentMethodologyLoader({
      ddb,
      s3,
      tableName: values['blocks-table'],
      bucket: values['artifacts-bucket'],
    }));
  }
  const result = await auditCompletion({ store, loadPlan, scope, checkpoint });
  const output =
    [...result.findings, result.summary].map((row) => JSON.stringify(row)).join('\n') + '\n';
  if (values.output) await writeFile(values.output, output, { mode: 0o600 });
  else process.stdout.write(output);
  if (values.checkpoint)
    await writeFile(
      values.checkpoint,
      JSON.stringify(result.checkpoint ? { source, audit: result.checkpoint } : null, null, 2) +
        '\n',
      {
        mode: 0o600,
      },
    );
  return result.summary.metrics.incomplete ||
    result.summary.metrics.unknown ||
    result.summary.discoveryUnverified
    ? 2
    : result.summary.finished
      ? 0
      : 3;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          type: 'execution.completion.error',
          state: 'unknown',
          reason: 'audit_failed_or_invalid_scope',
          message:
            /^(Explicit project|Completion audit checkpoint|Live reads require|--max-requests|(?:maxExecutions|pageSize|maxPages|maxRecordsPerExecution) must)/.test(
              error.message,
            )
              ? error.message
              : 'Audit failed. Check input/output paths and use --help for required arguments.',
        }),
      );
      process.exitCode = 2;
    });
}
