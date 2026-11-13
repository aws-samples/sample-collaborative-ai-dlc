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
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createProcessStore } from '../lambda/shared/v2-process-store.js';
import { createIntentMethodologyLoader } from '../lambda/shared/intent-methodology.js';
import {
  auditCompletion,
  validateCompletionAuditScope,
} from '../lambda/shared/completion-audit.js';

export const readBudget = (maxRequests) => {
  let requests = 0;
  let exhausted = false;
  return {
    get requests() {
      return requests;
    },
    get exhausted() {
      return exhausted;
    },
    wrap: (client) => ({
      send(command) {
        if (
          ![
            'GetCommand',
            'QueryCommand',
            'BatchGetCommand',
            'GetObjectCommand',
            'GetCallerIdentityCommand',
          ].includes(command.constructor.name)
        ) {
          throw new Error('Completion audit allows targeted reads only');
        }
        if (requests >= maxRequests) {
          exhausted = true;
          throw new Error('Completion audit request limit reached');
        }
        requests++;
        return client.send(command);
      },
    }),
  };
};

const createAuditClients = async (values) => {
  // Resolve once: the identity check and every data read must use the same
  // credentials even if a profile or credential source changes during a batch.
  const provider = values.profile ? fromIni({ profile: values.profile }) : fromNodeProviderChain();
  const options = { region: values.region, maxAttempts: 2, credentials: await provider() };
  return {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient(options)),
    s3: new S3Client(options),
    sts: new STSClient(options),
  };
};

export const main = async (
  args = process.argv.slice(2),
  { createClients = createAuditClients, stdout = process.stdout } = {},
) => {
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
    stdout.write(
      [
        'Read-only completion audit. No repairs, provider calls or model calls.',
        'Required: --project ID --from ISO_UTC --to ISO_UTC (execution start time, [from,to)).',
        'Live: --region REGION --table PROCESS_TABLE --blocks-table BLOCKS_TABLE',
        '      [--profile READ_PROFILE] [--artifacts-bucket BUCKET]',
        'Offline: --fixture FILE',
        'Bounds: --status SUCCEEDED|FAILED|CANCELLED --limit 100 --page-size 25',
        '        --max-pages 10 --record-limit 2000 --max-requests 5000',
        'Output: JSONL stdout, or --output FILE. Resume: --checkpoint FILE.',
        'Exit: 0 finished, 2 incomplete/unverified/error, 3 unfinished (including budget stop).',
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
  const maxRequests = Number(values['max-requests'] ?? 5000);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000) {
    throw new Error('--max-requests must be 1..10000');
  }
  const budget = readBudget(maxRequests);
  let clients;
  let accountId;
  if (!values.fixture) {
    if (!values.table || !values['blocks-table'] || !values.region) {
      throw new Error('Live reads require explicit --table, --blocks-table and --region');
    }
    clients = await createClients(values);
    const identity = await budget.wrap(clients.sts).send(new GetCallerIdentityCommand({}));
    if (!/^\d{12}$/.test(identity.Account ?? '')) {
      throw new Error('Completion audit could not verify the AWS account');
    }
    accountId = identity.Account;
  }
  let checkpoint = null;
  const source = values.fixture
    ? { fixture: resolve(values.fixture) }
    : {
        accountId,
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
          items: selected.slice(offset, offset + limit).map((f, i) => ({
            ...f.records.meta,
            cursor: { offset: offset + i + 1 },
          })),
          cursor: offset + limit < selected.length ? { offset: offset + limit } : null,
        };
      },
      getCompletionRecords: async (id) => fixtureFor(id).records,
      getExecution: async (id) => fixtureFor(id).records.meta,
      getUnitPlan: async (id) => fixtureFor(id).records.unitPlan ?? null,
    };
    loadPlan = async (meta) => fixtureFor(meta.executionId).planResult;
  } else {
    const ddb = budget.wrap(clients.ddb);
    const s3 = budget.wrap(clients.s3);
    store = createProcessStore({ ddb, tableName: values.table });
    ({ loadPlan } = createIntentMethodologyLoader({
      ddb,
      s3,
      tableName: values['blocks-table'],
      bucket: values['artifacts-bucket'],
    }));
  }
  const result = await auditCompletion({ store, loadPlan, scope, checkpoint, budget });
  result.summary.requests = budget.requests;
  const output =
    [...result.findings, result.summary].map((row) => JSON.stringify(row)).join('\n') + '\n';
  if (values.output) await writeFile(values.output, output, { mode: 0o600 });
  else
    await new Promise((resolve, reject) => {
      stdout.write(output, (error) => (error ? reject(error) : resolve()));
    });
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
