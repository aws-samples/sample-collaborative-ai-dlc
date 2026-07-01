'use strict';

// V2 process store — the thin DynamoDB I/O shell over the pure key scheme +
// record builders in v2-process-keys.js. The AgentCore container uses this to
// write execution/stage/event/human/metric state; a future trigger/resume
// lambda uses the same store to read execution state and answer human gates.
//
// Conventions mirror the codebase: a factory `createProcessStore({ ddb, tableName })`
// returning bound methods, conditional writes guarding state transitions, and an
// injectable clock/ids so tests stay deterministic. No business (Neptune) writes
// happen here — this is process state only.

const { randomUUID } = require('node:crypto');
const { GetCommand, PutCommand, QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const {
  META,
  executionMetaKey,
  stageKey,
  humanTaskKey,
  executionPk,
  projectPk,
  projectStatusIndex,
  executionTypeStateIndex,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildMetricRow,
  buildSensorRow,
  buildOutputRow,
} = require('./v2-process-keys.js');

const bySk = (a, b) => a.sk.localeCompare(b.sk);

const createProcessStore = ({ ddb, tableName, clock, ids } = {}) => {
  if (!ddb) throw new Error('createProcessStore requires a DynamoDB DocumentClient');
  const table = () => tableName ?? process.env.V2_PROCESS_TABLE;
  const now = () => (clock ? clock() : new Date().toISOString());
  const nextId = () => (ids ? ids() : randomUUID());

  // Create the execution META row. Conditional so a re-invoke (same session)
  // never clobbers an in-flight execution. `init-ws` calls this once.
  const createExecution = async (input) => {
    const startedAt = input.startedAt ?? now();
    const item = buildExecutionMeta({ ...input, startedAt });
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return item;
  };

  const getExecution = async (executionId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: executionMetaKey(executionId) }),
    );
    return Item ?? null;
  };

  // Update the execution-level status + current phase/stage + pending gate, and
  // re-stamp the GSI projections. `fromStatus` (optional) makes it a CAS.
  const updateExecution = async ({
    executionId,
    projectId,
    status,
    fromStatus = null,
    currentPhase,
    currentStage,
    pendingHumanTaskId,
    startedAt,
    completedAt,
    failureReason,
  }) => {
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const names = {};
    const values = { ':ts': ts };
    if (status !== undefined) {
      sets.push('#status = :status', 'GSI1PK = :g1pk', 'GSI1SK = :g1sk', 'GSI2SK = :g2sk');
      names['#status'] = 'status';
      values[':status'] = status;
      values[':g1pk'] = projectPk(projectId);
      values[':g1sk'] = projectStatusIndex({ projectId, status, startedAt, executionId }).GSI1SK;
      values[':g2sk'] = executionTypeStateIndex({
        executionId,
        type: 'EXECUTION',
        state: status,
        id: META,
      }).GSI2SK;
    }
    if (currentPhase !== undefined) {
      sets.push('currentPhase = :cp');
      values[':cp'] = currentPhase;
    }
    if (currentStage !== undefined) {
      sets.push('currentStage = :cs');
      values[':cs'] = currentStage;
    }
    if (pendingHumanTaskId !== undefined) {
      sets.push('pendingHumanTaskId = :ph');
      values[':ph'] = pendingHumanTaskId;
    }
    if (completedAt !== undefined) {
      sets.push('completedAt = :ca');
      values[':ca'] = completedAt;
    }
    if (failureReason !== undefined) {
      sets.push('failureReason = :fr');
      values[':fr'] = failureReason;
    }
    const params = {
      TableName: table(),
      Key: executionMetaKey(executionId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length) params.ExpressionAttributeNames = names;
    if (fromStatus) {
      params.ConditionExpression = '#status = :fromStatus';
      params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, '#status': 'status' };
      params.ExpressionAttributeValues[':fromStatus'] = fromStatus;
    }
    const { Attributes } = await ddb.send(new UpdateCommand(params));
    return Attributes;
  };

  // Upsert a stage row in a given state (the container marks RUNNING at start and
  // a terminal state at end). Not a CAS — the container owns its stage lifecycle
  // within a session; idempotent re-writes are fine.
  const putStage = async (input) => {
    const item = buildStageRow({ ...input, now: now() });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  const getStage = async (executionId, stageInstanceId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: stageKey(executionId, stageInstanceId) }),
    );
    return Item ?? null;
  };

  // Patch a stage's state + terminal fields, re-stamping GSI2. `cli`/`cliSessionId`
  // are set only when supplied (a Kiro session id is captured post-exit, so the
  // terminal/park write back-fills it; an undefined value leaves the field intact).
  const updateStageState = async ({
    executionId,
    stageInstanceId,
    state,
    runtimeError = null,
    completedAt = null,
    cli,
    cliSessionId,
  }) => {
    const ts = now();
    const sets = ['#state = :state', 'updatedAt = :ts', 'GSI2SK = :g2sk', 'runtimeError = :err'];
    const values = {
      ':state': state,
      ':ts': ts,
      ':g2sk': executionTypeStateIndex({ executionId, type: 'STAGE', state, id: stageInstanceId })
        .GSI2SK,
      ':err': runtimeError,
    };
    if (completedAt !== null) {
      sets.push('completedAt = :ca');
      values[':ca'] = completedAt === true ? ts : completedAt;
    }
    if (cli !== undefined) {
      sets.push('cli = :cli');
      values[':cli'] = cli;
    }
    if (cliSessionId !== undefined) {
      sets.push('cliSessionId = :csid');
      values[':csid'] = cliSessionId;
    }
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: stageKey(executionId, stageInstanceId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  const appendEvent = async ({
    executionId,
    type,
    stageInstanceId,
    actor,
    summary,
    payloadRef,
  }) => {
    const item = buildEventRow({
      executionId,
      type,
      stageInstanceId,
      actor,
      summary,
      payloadRef,
      now: now(),
      eventId: nextId(),
    });
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return item;
  };

  // Open a pending human gate (question/approval/review-verdict). Returns the
  // record; the caller separately parks the stage + execution as WAITING.
  const createHumanTask = async ({
    executionId,
    stageInstanceId,
    kind,
    prompt,
    options,
    questions,
    humanTaskId,
  }) => {
    const id = humanTaskId ?? nextId();
    const item = buildHumanTaskRow({
      executionId,
      humanTaskId: id,
      stageInstanceId,
      kind,
      prompt,
      options,
      questions,
      now: now(),
    });
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return item;
  };

  // Stamp the durable-execution callback id on a gate (the orchestrator does
  // this right after it parks, so the answer path knows which suspended
  // callback to resume). Not a CAS — the orchestrator owns this write.
  const setGateCallbackId = async ({ executionId, humanTaskId, callbackId }) => {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: humanTaskKey(executionId, humanTaskId),
        UpdateExpression: 'SET callbackId = :cb',
        ExpressionAttributeValues: { ':cb': callbackId },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  const getHumanTask = async (executionId, humanTaskId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: humanTaskKey(executionId, humanTaskId) }),
    );
    return Item ?? null;
  };

  // Resolve a pending human gate (CAS on status=pending so it can't be answered
  // twice). `answer` is the structured answer payload.
  const answerHumanTask = async ({ executionId, humanTaskId, status, answer, answeredBy }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: humanTaskKey(executionId, humanTaskId),
          ConditionExpression: '#status = :pending',
          UpdateExpression:
            'SET #status = :status, answer = :answer, answeredBy = :by, answeredAt = :ts, GSI2SK = :g2sk',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':status': status,
            ':answer': answer ?? null,
            ':by': answeredBy ?? null,
            ':ts': ts,
            ':g2sk': executionTypeStateIndex({
              executionId,
              type: 'HUMAN',
              state: status,
              id: humanTaskId,
            }).GSI2SK,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes;
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  };

  const recordMetric = async ({ executionId, stageInstanceId, metrics }) => {
    const item = buildMetricRow({
      executionId,
      stageInstanceId,
      metricId: nextId(),
      metrics,
      now: now(),
    });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  // Persist a deterministic sensor verdict for a stage. Append-only (each run is
  // a distinct row keyed by ts+id), so a re-run never clobbers a prior verdict.
  const recordSensorRun = async ({
    executionId,
    stageInstanceId,
    sensorId,
    kind,
    severity,
    result,
    held = false,
    detail = null,
  }) => {
    const item = buildSensorRow({
      executionId,
      stageInstanceId,
      sensorRunId: nextId(),
      sensorId,
      kind,
      severity,
      result,
      held,
      detail,
      now: now(),
    });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  // Append an agent output chunk for restore-on-reload. The sequence is an atomic
  // counter on the META row (ADD), so concurrent chunks never collide and SK sort
  // == emit order. The live copy is broadcast over the websocket by the caller.
  const appendOutput = async ({ executionId, stageInstanceId, kind = 'text', content }) => {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: executionMetaKey(executionId),
        UpdateExpression: 'ADD outputSeq :one',
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const seq = Number(Attributes?.outputSeq ?? 1);
    const item = buildOutputRow({ executionId, stageInstanceId, seq, kind, content, now: now() });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  // Read output chunks in emit order (for restore-on-reload).
  const getOutputs = async (executionId) => {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'OUTPUT#' },
      }),
    );
    return Items ?? [];
  };

  // List a project's executions (intents) newest-first via GSI1. Optionally
  // filter to a single status. Returns the META rows only — the intents list
  // view doesn't need the full per-execution record set.
  const listProjectExecutions = async ({ projectId, status = null, limit = 100 } = {}) => {
    const values = { ':pk': projectPk(projectId) };
    let keyCond = 'GSI1PK = :pk';
    if (status) {
      keyCond += ' AND begins_with(GSI1SK, :sk)';
      values[':sk'] = `STATUS#${status}#`;
    }
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: table(),
        IndexName: 'GSI1',
        KeyConditionExpression: keyCond,
        ExpressionAttributeValues: values,
        ScanIndexForward: false, // newest first
        Limit: limit,
      }),
    );
    return Items ?? [];
  };

  // Patch the intent-config fields on an existing META row (prompt/branch/etc.)
  // while it is still a DRAFT. Independent of updateExecution (which owns the
  // lifecycle/status + GSI re-stamp). Used by the intents CRUD edit path.
  const patchExecutionConfig = async ({
    executionId,
    title,
    prompt,
    branch,
    baseBranch,
    repos,
  }) => {
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const values = { ':ts': ts };
    const maybe = (field, key, val) => {
      if (val !== undefined) {
        sets.push(`${field} = ${key}`);
        values[key] = val;
      }
    };
    maybe('title', ':title', title);
    maybe('prompt', ':prompt', prompt);
    maybe('branch', ':branch', branch);
    maybe('baseBranch', ':baseBranch', baseBranch);
    maybe('repos', ':repos', repos);
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: executionMetaKey(executionId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  // Read every record for an execution, grouped by type (for the resume lambda /
  // admin / restore-on-reload).
  const getExecutionRecords = async (executionId) => {
    const { Items } = await ddb.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': executionPk(executionId) },
      }),
    );
    const records = (Items ?? []).toSorted(bySk);
    return {
      meta: records.find((r) => r.sk === META) ?? null,
      stages: records.filter((r) => r.sk.startsWith('STAGE#')),
      events: records.filter((r) => r.sk.startsWith('EVENT#')),
      humanTasks: records.filter((r) => r.sk.startsWith('HUMAN#')),
      metrics: records.filter((r) => r.sk.startsWith('METRIC#')),
      sensorRuns: records.filter((r) => r.sk.startsWith('SENSOR#')),
      outputs: records.filter((r) => r.sk.startsWith('OUTPUT#')),
    };
  };

  return {
    createExecution,
    getExecution,
    updateExecution,
    putStage,
    getStage,
    updateStageState,
    appendEvent,
    createHumanTask,
    getHumanTask,
    setGateCallbackId,
    answerHumanTask,
    recordMetric,
    recordSensorRun,
    appendOutput,
    getOutputs,
    listProjectExecutions,
    patchExecutionConfig,
    getExecutionRecords,
  };
};

module.exports = { createProcessStore };
