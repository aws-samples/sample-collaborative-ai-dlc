// Creates or replaces the reporting lake's Athena views.
//
// Terraform invokes this function (aws_lambda_invocation) with the contents of
// terraform/modules/reporting/views/*.sql whenever a file changes:
//
//   { "files": [{ "name": "010-latest.sql", "sql": "CREATE OR REPLACE VIEW ..." }] }
//
// Files run in the order given, and statements within a file in order, so a
// view can build on one defined earlier. A failed statement fails the
// invocation, and with it the apply.
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@aws-lambda-powertools/logger';
import {
  AthenaClient,
  GetQueryExecutionCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';

const logger = new Logger();

const FIRST_POLL_MS = 250;
const MAX_POLL_MS = 2000;

// A file can hold several statements, each ending with ";" at the end of a
// line. Comment-only lines are dropped: Athena's CREATE VIEW keeps the text,
// and leading comments would make every view definition noisy.
export const splitStatements = (sql) =>
  sql
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((statement) =>
      statement
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean);

export const createApplyViews = ({
  athena = new AthenaClient({}),
  workGroup = process.env.ATHENA_WORKGROUP,
  database = process.env.GLUE_DATABASE,
  wait = sleep,
} = {}) => {
  const run = async (statement) => {
    const { QueryExecutionId } = await athena.send(
      new StartQueryExecutionCommand({
        QueryString: statement,
        WorkGroup: workGroup,
        QueryExecutionContext: { Database: database },
      }),
    );
    for (let delay = FIRST_POLL_MS; ; delay = Math.min(delay * 2, MAX_POLL_MS)) {
      await wait(delay);
      const { QueryExecution } = await athena.send(
        new GetQueryExecutionCommand({ QueryExecutionId }),
      );
      const { State, StateChangeReason } = QueryExecution.Status;
      if (State === 'SUCCEEDED') return;
      if (State === 'FAILED' || State === 'CANCELLED') {
        throw new Error(`${State}: ${StateChangeReason ?? 'no reason given'}`);
      }
    }
  };

  return async (event) => {
    let applied = 0;
    for (const { name, sql } of event.files ?? []) {
      for (const statement of splitStatements(sql)) {
        try {
          await run(statement);
        } catch (error) {
          throw new Error(`${name}: ${error.message}`, { cause: error });
        }
        applied += 1;
      }
      logger.info('Applied view file', { name });
    }
    return { applied };
  };
};

export const handler = createApplyViews();
