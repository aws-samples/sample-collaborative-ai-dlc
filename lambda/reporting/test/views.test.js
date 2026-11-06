import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  AthenaClient,
  GetQueryExecutionCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { mockClient } from 'aws-sdk-client-mock';
import { createApplyViews, splitStatements } from '../views.js';

const athena = new AthenaClient({ region: 'us-east-1' });
const athenaMock = mockClient(athena);
const noWait = async () => {};

const applyViews = () =>
  createApplyViews({ athena, workGroup: 'wg', database: 'db', wait: noWait });

beforeEach(() => {
  athenaMock.reset();
});

describe('splitStatements', () => {
  it('splits on a semicolon at the end of a line and drops comment lines', () => {
    const sql = [
      '-- first view',
      'CREATE OR REPLACE VIEW a AS',
      "SELECT ';' AS semi FROM t;",
      '-- second view',
      'CREATE OR REPLACE VIEW b AS SELECT 1',
      '',
    ].join('\n');
    expect(splitStatements(sql)).toEqual([
      "CREATE OR REPLACE VIEW a AS\nSELECT ';' AS semi FROM t",
      'CREATE OR REPLACE VIEW b AS SELECT 1',
    ]);
  });

  it('finds one CREATE OR REPLACE VIEW per statement in every shipped view file', () => {
    const dir = new URL('../../../terraform/modules/reporting/views/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const statements = splitStatements(readFileSync(new URL(file, dir), 'utf8'));
      expect(statements.length, file).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, file).toMatch(/^CREATE OR REPLACE VIEW \w+ AS\b/);
        expect(statement.match(/CREATE OR REPLACE VIEW/g), file).toHaveLength(1);
      }
    }
  });
});

describe('apply views', () => {
  it('runs every statement in order in the workgroup and database', async () => {
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q' });
    athenaMock
      .on(GetQueryExecutionCommand)
      .resolvesOnce({ QueryExecution: { Status: { State: 'RUNNING' } } })
      .resolves({ QueryExecution: { Status: { State: 'SUCCEEDED' } } });

    const result = await applyViews()({
      files: [
        {
          name: '010-a.sql',
          sql: 'CREATE OR REPLACE VIEW a AS SELECT 1;\nCREATE OR REPLACE VIEW b AS SELECT 2',
        },
        { name: '020-c.sql', sql: 'CREATE OR REPLACE VIEW c AS SELECT 3' },
      ],
    });

    expect(result).toEqual({ applied: 3 });
    const inputs = athenaMock.commandCalls(StartQueryExecutionCommand).map((c) => c.args[0].input);
    expect(inputs.map((i) => i.QueryString)).toEqual([
      'CREATE OR REPLACE VIEW a AS SELECT 1',
      'CREATE OR REPLACE VIEW b AS SELECT 2',
      'CREATE OR REPLACE VIEW c AS SELECT 3',
    ]);
    expect(inputs[0]).toMatchObject({ WorkGroup: 'wg', QueryExecutionContext: { Database: 'db' } });
  });

  it('fails with the file name and Athena reason, and stops there', async () => {
    athenaMock.on(StartQueryExecutionCommand).resolves({ QueryExecutionId: 'q' });
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: { State: 'FAILED', StateChangeReason: 'line 1:1: mismatched input' },
      },
    });

    await expect(
      applyViews()({
        files: [
          { name: '010-a.sql', sql: 'CREATE OR REPLACE VIEW a AS SELEC 1' },
          { name: '020-b.sql', sql: 'CREATE OR REPLACE VIEW b AS SELECT 2' },
        ],
      }),
    ).rejects.toThrow('010-a.sql: FAILED: line 1:1: mismatched input');
    expect(athenaMock.commandCalls(StartQueryExecutionCommand)).toHaveLength(1);
  });
});
