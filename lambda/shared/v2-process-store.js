// V2 process store — the thin DynamoDB I/O shell over the pure key scheme +
// record builders in v2-process-keys.js. The AgentCore container uses this to
// write execution/stage/event/human/metric state; a future trigger/resume
// lambda uses the same store to read execution state and answer human gates.
//
// Conventions mirror the codebase: a factory `createProcessStore({ ddb, tableName })`
// returning bound methods, conditional writes guarding state transitions, and an
// injectable clock/ids so tests stay deterministic. No business (Neptune) writes
// happen here — this is process state only.

import { randomUUID } from 'node:crypto';
import {
  BatchWriteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  META,
  executionMetaKey,
  stageKey,
  humanTaskKey,
  steeringKey,
  unitPlanKey,
  unitKey,
  executionPk,
  projectPk,
  projectStatusIndex,
  executionTypeStateIndex,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildMetricRow,
  buildGraphReadRow,
  buildSensorRow,
  buildSteeringRow,
  buildOutputRow,
  buildUnitPlanRow,
  buildUnitRow,
  UNIT_STATES,
  CONSTRUCTION_AUTONOMY_MODES,
} from './v2-process-keys.js';

const bySk = (a, b) => a.sk.localeCompare(b.sk);

// A DynamoDB Query returns at most 1MB per page; a long run's partition (agent
// output chunks alone can exceed that) silently truncates without this loop.
// Always drain LastEvaluatedKey so callers see the COMPLETE record set — the
// detail DTO rendering stages as PENDING because STAGE# rows sorted past the
// first page was exactly this bug.
const queryAll = async (ddb, input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

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
  // `ifOrchestratorRunId` (optional) additionally requires META to still carry
  // that ownership token — a retired orchestrator run (cancel/rewind relaunch)
  // fails the condition instead of clobbering the new run's state.
  const updateExecution = async ({
    executionId,
    projectId,
    status,
    fromStatus = null,
    ifOrchestratorRunId = null,
    orchestratorRunId,
    rewindFromStageId,
    currentPhase,
    currentStage,
    pendingHumanTaskId,
    startedAt,
    completedAt,
    failureReason,
    constructionAutonomyMode,
  }) => {
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const names = {};
    const values = { ':ts': ts };
    if (status !== undefined) {
      // The GSI1 projection (a project's executions by status) must be re-stamped
      // whenever status changes. It is built from projectId + startedAt, both of
      // which are IMMUTABLE on the META row. Runtime callers (run-stage,
      // process-bridge park/un-park) only have executionId in scope and omit them —
      // so back-fill from the existing row rather than writing PROJECT#undefined /
      // STARTED#undefined, which would orphan the intent from the list query.
      let projId = projectId;
      let started = startedAt;
      if (projId === undefined || started === undefined) {
        const existing = await getExecution(executionId);
        projId = projId ?? existing?.projectId;
        started = started ?? existing?.startedAt;
      }
      sets.push('#status = :status', 'GSI1PK = :g1pk', 'GSI1SK = :g1sk', 'GSI2SK = :g2sk');
      names['#status'] = 'status';
      values[':status'] = status;
      values[':g1pk'] = projectPk(projId);
      values[':g1sk'] = projectStatusIndex({
        projectId: projId,
        status,
        startedAt: started,
        executionId,
      }).GSI1SK;
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
    if (orchestratorRunId !== undefined) {
      sets.push('orchestratorRunId = :orid');
      values[':orid'] = orchestratorRunId;
    }
    if (rewindFromStageId !== undefined) {
      sets.push('rewindFromStageId = :rwf');
      values[':rwf'] = rewindFromStageId;
    }
    // The autonomy-ladder decision (docs/v2-parallel.md A2 rule 9), stamped by
    // the orchestrator when the human answers the ladder prompt. Validated at
    // the write so a malformed answer can never poison the scheduling mode.
    if (constructionAutonomyMode !== undefined) {
      if (
        constructionAutonomyMode !== null &&
        !CONSTRUCTION_AUTONOMY_MODES.includes(constructionAutonomyMode)
      ) {
        throw new Error(`invalid constructionAutonomyMode: ${constructionAutonomyMode}`);
      }
      sets.push('constructionAutonomyMode = :cam');
      values[':cam'] = constructionAutonomyMode;
    }
    const params = {
      TableName: table(),
      Key: executionMetaKey(executionId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length) params.ExpressionAttributeNames = names;
    const conditions = [];
    if (fromStatus) {
      conditions.push('#status = :fromStatus');
      params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, '#status': 'status' };
      params.ExpressionAttributeValues[':fromStatus'] = fromStatus;
    }
    if (ifOrchestratorRunId) {
      conditions.push('orchestratorRunId = :ifOrid');
      params.ExpressionAttributeValues[':ifOrid'] = ifOrchestratorRunId;
    }
    if (conditions.length) params.ConditionExpression = conditions.join(' AND ');
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
  // `parkedAt: true` stamps the park moment (WAITING_FOR_HUMAN) for human-wait
  // accounting — resumeStageRow folds it into waitMs and clears it.
  const updateStageState = async ({
    executionId,
    stageInstanceId,
    state,
    runtimeError = null,
    completedAt = null,
    parkedAt,
    cli,
    cliSessionId,
    resolvedModel,
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
    if (parkedAt !== undefined) {
      sets.push('parkedAt = :pa');
      values[':pa'] = parkedAt === true ? ts : parkedAt;
    }
    if (cli !== undefined) {
      sets.push('cli = :cli');
      values[':cli'] = cli;
    }
    if (cliSessionId !== undefined) {
      sets.push('cliSessionId = :csid');
      values[':csid'] = cliSessionId;
    }
    if (resolvedModel !== undefined) {
      sets.push('resolvedModel = :rm');
      values[':rm'] = resolvedModel;
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

  // Flip a parked stage (WAITING_FOR_HUMAN) back to RUNNING on resume WITHOUT
  // rebuilding the row: startedAt and attempt are preserved (the wall-clock
  // duration spans the whole stage including waits), the open park window
  // (now − parkedAt) is folded into the waitMs accumulator and parkedAt is
  // cleared. The conversation handle + callback id are refreshed for the new
  // container leg. Contrast putStage, which is a full-row replace for FRESH
  // runs only — using it on a resume was the "duration resets on answer" bug.
  const resumeStageRow = async ({
    executionId,
    stageInstanceId,
    cli,
    cliSessionId,
    resolvedModel,
    stageCallbackId,
  }) => {
    const existing = await getStage(executionId, stageInstanceId);
    const ts = now();
    // Fold the open park window into the accumulator. Guarded parses: an
    // unparsable timestamp contributes 0 rather than poisoning waitMs with NaN.
    const parsedNow = Date.parse(ts);
    const parsedParked = existing?.parkedAt ? Date.parse(existing.parkedAt) : NaN;
    const parkedMs =
      Number.isFinite(parsedNow) && Number.isFinite(parsedParked)
        ? Math.max(0, parsedNow - parsedParked)
        : 0;
    const sets = [
      '#state = :state',
      'updatedAt = :ts',
      'GSI2SK = :g2sk',
      'runtimeError = :null',
      'parkedAt = :null',
      'waitMs = :wait',
    ];
    const values = {
      ':state': 'RUNNING',
      ':ts': ts,
      ':g2sk': executionTypeStateIndex({
        executionId,
        type: 'STAGE',
        state: 'RUNNING',
        id: stageInstanceId,
      }).GSI2SK,
      ':null': null,
      ':wait': (Number.isFinite(Number(existing?.waitMs)) ? Number(existing.waitMs) : 0) + parkedMs,
    };
    if (cli !== undefined) {
      sets.push('cli = :cli');
      values[':cli'] = cli;
    }
    if (cliSessionId !== undefined) {
      sets.push('cliSessionId = :csid');
      values[':csid'] = cliSessionId;
    }
    if (resolvedModel !== undefined) {
      sets.push('resolvedModel = :rm');
      values[':rm'] = resolvedModel;
    }
    if (stageCallbackId !== undefined) {
      sets.push('stageCallbackId = :scb');
      values[':scb'] = stageCallbackId;
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
    unitSlug,
    actor,
    summary,
    payloadRef,
  }) => {
    const item = buildEventRow({
      executionId,
      type,
      stageInstanceId,
      unitSlug,
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
    unitSlug,
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
      unitSlug,
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
  const answerHumanTask = async ({
    executionId,
    humanTaskId,
    status,
    answer,
    answeredBy,
    answeredByName,
  }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: humanTaskKey(executionId, humanTaskId),
          ConditionExpression: '#status = :pending',
          UpdateExpression:
            'SET #status = :status, answer = :answer, answeredBy = :by, answeredByName = :byName, answeredAt = :ts, GSI2SK = :g2sk',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':status': status,
            ':answer': answer ?? null,
            ':by': answeredBy ?? null,
            ':byName': answeredByName ?? null,
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

  // Retire a still-pending gate whose run is being cancelled/rewound (CAS on
  // pending — an already-answered gate is left alone). The gate stays as the
  // audit record; `supersededBy` names the steering row / action that retired it.
  const supersedeHumanTask = async ({ executionId, humanTaskId, supersededBy = null }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: humanTaskKey(executionId, humanTaskId),
          ConditionExpression: '#status = :pending',
          UpdateExpression:
            'SET #status = :status, supersededAt = :ts, supersededBy = :by, GSI2SK = :g2sk',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':status': 'superseded',
            ':ts': ts,
            ':by': supersededBy,
            ':g2sk': executionTypeStateIndex({
              executionId,
              type: 'HUMAN',
              state: 'superseded',
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

  // Stamp a revision marker on an already-answered gate. The original answer is
  // immutable — the correction lives in the referenced STEER row; this marker
  // just lets readers render "this answer was revised". CAS on NOT pending (a
  // pending gate is answered, not revised).
  const markGateRevised = async ({ executionId, humanTaskId, steerId }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: humanTaskKey(executionId, humanTaskId),
          ConditionExpression: 'attribute_exists(pk) AND #status <> :pending',
          UpdateExpression: 'SET revisedAt = :ts, revisionSteerId = :sid',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':pending': 'pending', ':ts': ts, ':sid': steerId },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes;
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  };

  // Record a human steering / course-correction message (docs/v2-steering.md).
  // Immutable once written; delivery flips pending → consumed at a deterministic
  // injection point (gate resume / fresh stage start).
  const createSteering = async ({
    executionId,
    kind,
    message,
    targetGateId = null,
    targetStageId = null,
    createdBy = null,
    createdByName = null,
    steerId,
  }) => {
    const id = steerId ?? `st-${nextId()}`;
    const item = buildSteeringRow({
      executionId,
      steerId: id,
      kind,
      message,
      targetGateId,
      targetStageId,
      createdBy,
      createdByName,
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

  // All steering rows for an execution, oldest first (SK sorts by createdAt).
  const listSteering = async (executionId) =>
    queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'STEER#' },
    });

  // Only the not-yet-delivered steering rows, oldest first — what run-stage
  // injects at its next entry. Uses GSI2 (TYPE#STEER#STATE#pending#). Paginated:
  // a dropped page here would silently swallow a user's correction.
  const listPendingSteering = async (executionId) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk AND begins_with(GSI2SK, :p)',
      ExpressionAttributeValues: {
        ':pk': executionPk(executionId),
        ':p': 'TYPE#STEER#STATE#pending#',
      },
    });
    return items.toSorted(bySk);
  };

  // Flip a steering row pending → consumed (CAS) as it enters an agent
  // conversation. `createdAt` locates the row (part of the SK).
  const markSteeringConsumed = async ({
    executionId,
    steerId,
    createdAt,
    stageInstanceId = null,
  }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: steeringKey(executionId, createdAt, steerId),
          ConditionExpression: '#status = :pending',
          UpdateExpression:
            'SET #status = :status, consumedAt = :ts, consumedByStageInstanceId = :sid, GSI2SK = :g2sk',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':status': 'consumed',
            ':ts': ts,
            ':sid': stageInstanceId,
            ':g2sk': executionTypeStateIndex({
              executionId,
              type: 'STEER',
              state: 'consumed',
              id: steerId,
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

  // Retire a pending steering row that a newer correction replaces (CAS on
  // pending — a consumed row is history and stays as-is).
  const supersedeSteering = async ({ executionId, steerId, createdAt, supersededBy = null }) => {
    const ts = now();
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: steeringKey(executionId, createdAt, steerId),
          ConditionExpression: '#status = :pending',
          UpdateExpression:
            'SET #status = :status, supersededAt = :ts, supersededBy = :by, GSI2SK = :g2sk',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':status': 'superseded',
            ':ts': ts,
            ':by': supersededBy,
            ':g2sk': executionTypeStateIndex({
              executionId,
              type: 'STEER',
              state: 'superseded',
              id: steerId,
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

  // Reset a stage row for a rewind: back to PENDING with attempt+1, conversation
  // handle + terminal fields cleared. A stage that never ran (no row yet) needs
  // no reset — returns null. The prior attempt's history stays in EVENT#/OUTPUT#.
  const resetStageRow = async ({ executionId, stageInstanceId }) => {
    const existing = await getStage(executionId, stageInstanceId);
    if (!existing) return null;
    const ts = now();
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: stageKey(executionId, stageInstanceId),
        UpdateExpression:
          'SET #state = :state, attempt = :attempt, cli = :null, cliSessionId = :null, ' +
          'runtimeError = :null, startedAt = :null, completedAt = :null, ' +
          'parkedAt = :null, waitMs = :zero, updatedAt = :ts, GSI2SK = :g2sk',
        ExpressionAttributeNames: { '#state': 'state' },
        ExpressionAttributeValues: {
          ':state': 'PENDING',
          ':attempt': Number(existing.attempt ?? 0) + 1,
          ':null': null,
          ':zero': 0,
          ':ts': ts,
          ':g2sk': executionTypeStateIndex({
            executionId,
            type: 'STAGE',
            state: 'PENDING',
            id: stageInstanceId,
          }).GSI2SK,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  const recordMetric = async ({
    executionId,
    stageInstanceId,
    unitSlug,
    metrics,
    resolvedModel = null,
    creditRate = null,
  }) => {
    const item = buildMetricRow({
      executionId,
      stageInstanceId,
      unitSlug,
      metricId: nextId(),
      metrics,
      resolvedModel,
      creditRate,
      now: now(),
    });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  const recordGraphRead = async ({
    executionId,
    stageInstanceId,
    unitSlug,
    tool,
    bytes = 0,
    resultCount = null,
    args = {},
  }) => {
    const item = buildGraphReadRow({
      executionId,
      stageInstanceId,
      unitSlug,
      readId: nextId(),
      tool,
      bytes,
      resultCount,
      args,
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
    unitSlug,
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
      unitSlug,
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
  const appendOutput = async ({
    executionId,
    stageInstanceId,
    unitSlug,
    kind = 'text',
    content,
  }) => {
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
    const item = buildOutputRow({
      executionId,
      stageInstanceId,
      unitSlug,
      seq,
      kind,
      content,
      now: now(),
    });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  // Read output chunks in emit order (for restore-on-reload / the lazy
  // per-pane transcript endpoint). Optional filters:
  //   stageInstanceId — only that stage's chunks; pass null EXPLICITLY (via
  //     `filterByStage: true`) to select the stage-less workspace/init bucket.
  //   afterSeq — only chunks with seq > afterSeq (incremental catch-up cursor).
  // Paginated: output partitions routinely exceed one 1MB Query page.
  const getOutputs = async (
    executionId,
    { stageInstanceId, filterByStage = stageInstanceId !== undefined, afterSeq = null } = {},
  ) => {
    const values = { ':pk': executionPk(executionId), ':p': 'OUTPUT#' };
    const filters = [];
    if (filterByStage) {
      if (stageInstanceId == null) {
        filters.push('attribute_not_exists(stageInstanceId) OR stageInstanceId = :null');
        values[':null'] = null;
      } else {
        filters.push('stageInstanceId = :sid');
        values[':sid'] = stageInstanceId;
      }
    }
    if (afterSeq != null) {
      filters.push('seq > :after');
      values[':after'] = Number(afterSeq);
    }
    return queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ...(filters.length > 0
        ? { FilterExpression: filters.map((f) => `(${f})`).join(' AND ') }
        : {}),
      ExpressionAttributeValues: values,
    });
  };

  // List a project's executions (intents) newest-first via GSI1. Optionally
  // filter to a single status. Returns the META rows only — the intents list
  // view doesn't need the full per-execution record set. Paginated up to
  // `limit`: DynamoDB stops a page at min(Limit, 1MB), and META rows carry the
  // unbounded user prompt — without the drain, a project with large prompts
  // would silently list fewer intents than exist.
  const listProjectExecutions = async ({ projectId, status = null, limit = 100 } = {}) => {
    const values = { ':pk': projectPk(projectId) };
    let keyCond = 'GSI1PK = :pk';
    if (status) {
      keyCond += ' AND begins_with(GSI1SK, :sk)';
      values[':sk'] = `STATUS#${status}#`;
    }
    const items = [];
    let ExclusiveStartKey;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName: table(),
          IndexName: 'GSI1',
          KeyConditionExpression: keyCond,
          ExpressionAttributeValues: values,
          ScanIndexForward: false, // newest first
          Limit: limit - items.length,
          ExclusiveStartKey,
        }),
      );
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < limit);
    return items;
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
    baseBranches,
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
    maybe('baseBranches', ':baseBranches', baseBranches);
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

  // ── Unit-of-work promotion (docs/v2-parallel.md WP3) ──
  // UNITPLAN is the frozen scheduling snapshot. A plain put: promotion after a
  // rewind of units-generation legitimately replaces the snapshot (UNIT rows
  // are protected separately by syncUnitRows).
  const putUnitPlan = async (input) => {
    const item = buildUnitPlanRow({ ...input, now: now() });
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
    return item;
  };

  const getUnitPlan = async (executionId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: unitPlanKey(executionId) }),
    );
    return Item ?? null;
  };

  const getUnit = async (executionId, slug) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: unitKey(executionId, slug) }),
    );
    return Item ?? null;
  };

  // All unit lane rows for an execution. SK prefix 'UNIT#' (exact — a bare
  // 'UNIT' would also match UNITPLAN). Paginated: the orchestrator's lane
  // scheduler reads this — a dropped page would make lanes invisible.
  const listUnits = async (executionId) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'UNIT#' },
    });
    return items.toSorted(bySk);
  };

  // Bring the UNIT# rows in line with a (re-)promoted DAG, without ever
  // touching a lane that already started:
  //   - missing slug            → create PENDING row
  //   - existing PENDING/READY  → refresh dependsOn/batchIndex (and reset to
  //                               PENDING — readiness is re-derived)
  //   - existing RUNNING/MERGING/MERGED/FAILED/BLOCKED → LEFT ALONE (reported
  //     in `preserved` so the caller can surface the mismatch)
  //   - row no longer in the DAG → LEFT in place but reported in `orphaned`
  //     (never deleted — it is audit history; the plan snapshot no longer
  //     references it, so the scheduler ignores it)
  const syncUnitRows = async ({ executionId, units, batches = [] }) => {
    const batchIndexOf = (slug) => {
      const i = batches.findIndex((b) => b.includes(slug));
      return i < 0 ? 0 : i;
    };
    const existing = await listUnits(executionId);
    const bySlug = new Map(existing.map((r) => [r.slug, r]));
    const created = [];
    const updated = [];
    const preserved = [];
    for (const u of units) {
      const slug = u.slug ?? u.name;
      const dependsOn = u.dependsOn ?? u.depends_on ?? [];
      const row = bySlug.get(slug);
      if (!row) {
        const item = buildUnitRow({
          executionId,
          slug,
          dependsOn,
          state: 'PENDING',
          batchIndex: batchIndexOf(slug),
          now: now(),
        });
        await ddb.send(new PutCommand({ TableName: table(), Item: item }));
        created.push(slug);
        continue;
      }
      if (row.state === 'PENDING' || row.state === 'READY') {
        const ts = now();
        await ddb.send(
          new UpdateCommand({
            TableName: table(),
            Key: unitKey(executionId, slug),
            UpdateExpression:
              'SET dependsOn = :deps, batchIndex = :bi, #state = :state, updatedAt = :ts, GSI2SK = :g2sk',
            ExpressionAttributeNames: { '#state': 'state' },
            ExpressionAttributeValues: {
              ':deps': dependsOn,
              ':bi': batchIndexOf(slug),
              ':state': 'PENDING',
              ':ts': ts,
              ':g2sk': executionTypeStateIndex({
                executionId,
                type: 'UNIT',
                state: 'PENDING',
                id: slug,
              }).GSI2SK,
            },
          }),
        );
        updated.push(slug);
      } else {
        preserved.push(slug);
      }
    }
    const dagSlugs = new Set(units.map((u) => u.slug ?? u.name));
    const orphaned = existing.filter((r) => !dagSlugs.has(r.slug)).map((r) => r.slug);
    return { created, updated, preserved, orphaned };
  };

  // Lane state transition, CAS'd on the expected prior state(s) so concurrent
  // lanes (WP5) can never double-start or clobber a terminal verdict. Returns
  // the new row, or null when the CAS lost. Extra lifecycle fields are stamped
  // by name (branch, sessionId, startedAt, mergedAt, failureReason, blockedOn).
  const updateUnitState = async ({ executionId, slug, state, fromStates = null, fields = {} }) => {
    if (!UNIT_STATES.includes(state)) throw new Error(`invalid unit state: ${state}`);
    const ts = now();
    const sets = ['#state = :state', 'updatedAt = :ts', 'GSI2SK = :g2sk'];
    const names = { '#state': 'state' };
    const values = {
      ':state': state,
      ':ts': ts,
      ':g2sk': executionTypeStateIndex({ executionId, type: 'UNIT', state, id: slug }).GSI2SK,
    };
    for (const [k, v] of Object.entries(fields)) {
      names[`#f_${k}`] = k;
      values[`:f_${k}`] = v === true && (k === 'startedAt' || k === 'mergedAt') ? ts : v;
      sets.push(`#f_${k} = :f_${k}`);
    }
    const params = {
      TableName: table(),
      Key: unitKey(executionId, slug),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Array.isArray(fromStates) && fromStates.length > 0) {
      params.ConditionExpression = `#state IN (${fromStates.map((_, i) => `:from${i}`).join(', ')})`;
      fromStates.forEach((s, i) => {
        params.ExpressionAttributeValues[`:from${i}`] = s;
      });
    }
    try {
      const { Attributes } = await ddb.send(new UpdateCommand(params));
      return Attributes;
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  };

  // Patch human decisions captured at the fan-out gate onto the UNITPLAN
  // snapshot (skip matrix / walking-skeleton pick / autonomy mode). Partial —
  // only supplied fields are written.
  const updateUnitPlanDecisions = async ({
    executionId,
    skipMatrix,
    walkingSkeleton,
    autonomyMode,
  }) => {
    const sets = ['updatedAt = :ts'];
    const values = { ':ts': now() };
    if (skipMatrix !== undefined) {
      sets.push('skipMatrix = :sm');
      values[':sm'] = skipMatrix;
    }
    if (walkingSkeleton !== undefined) {
      sets.push('walkingSkeleton = :ws');
      values[':ws'] = walkingSkeleton;
    }
    if (autonomyMode !== undefined) {
      sets.push('autonomyMode = :am');
      values[':am'] = autonomyMode;
    }
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: unitPlanKey(executionId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(pk)',
        ReturnValues: 'ALL_NEW',
      }),
    );
    return Attributes;
  };

  // Read every record for an execution, grouped by type (for the resume lambda /
  // admin / restore-on-reload). Fully paginated — see queryAll.
  //
  // `includeOutputs: false` skips the OUTPUT# rows entirely (two SK range
  // queries around the OUTPUT# prefix) instead of reading megabytes of
  // transcript the caller will throw away: the detail DTO polls this every few
  // seconds and outputs are the bulk of a long run's partition. '#' is 0x23;
  // '$' (0x24) is the next code point, so sk < 'OUTPUT#' and sk >= 'OUTPUT$'
  // partition the SK space exactly around the OUTPUT# prefix.
  const getExecutionRecords = async (executionId, { includeOutputs = true } = {}) => {
    const base = {
      TableName: table(),
      ExpressionAttributeValues: { ':pk': executionPk(executionId) },
    };
    const Items = includeOutputs
      ? await queryAll(ddb, { ...base, KeyConditionExpression: 'pk = :pk' })
      : [
          ...(await queryAll(ddb, {
            ...base,
            KeyConditionExpression: 'pk = :pk AND sk < :lo',
            ExpressionAttributeValues: { ':pk': executionPk(executionId), ':lo': 'OUTPUT#' },
          })),
          ...(await queryAll(ddb, {
            ...base,
            KeyConditionExpression: 'pk = :pk AND sk >= :hi',
            ExpressionAttributeValues: { ':pk': executionPk(executionId), ':hi': 'OUTPUT$' },
          })),
        ];
    const records = Items.toSorted(bySk);
    return {
      meta: records.find((r) => r.sk === META) ?? null,
      stages: records.filter((r) => r.sk.startsWith('STAGE#')),
      events: records.filter((r) => r.sk.startsWith('EVENT#')),
      humanTasks: records.filter((r) => r.sk.startsWith('HUMAN#')),
      metrics: records.filter((r) => r.sk.startsWith('METRIC#')),
      graphReads: records.filter((r) => r.sk.startsWith('READ#')),
      sensorRuns: records.filter((r) => r.sk.startsWith('SENSOR#')),
      steering: records.filter((r) => r.sk.startsWith('STEER#')),
      outputs: records.filter((r) => r.sk.startsWith('OUTPUT#')),
      unitPlan: records.find((r) => r.sk === 'UNITPLAN') ?? null,
      units: records.filter((r) => r.sk.startsWith('UNIT#')),
    };
  };

  // Delete EVERY record for an execution — the whole EXEC#<id> partition
  // (META, STAGE#, EVENT#, HUMAN#, METRIC#, OUTPUT#, SENSOR#, STEER#,
  // UNITPLAN, UNIT#). Keys-only projection: OUTPUT# rows can be megabytes and
  // we only need pk/sk to delete them. BatchWrite in chunks of 25 (the API
  // maximum), retrying UnprocessedItems with backoff so a throttled batch
  // never silently leaves rows behind. Idempotent — deleting a missing key is
  // a no-op, so a retried delete after a partial failure just finishes the job.
  const deleteExecution = async (executionId) => {
    const keys = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': executionPk(executionId) },
      ProjectionExpression: 'pk, sk',
    });
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys
        .slice(i, i + 25)
        .map((k) => ({ DeleteRequest: { Key: { pk: k.pk, sk: k.sk } } }));
      let attempt = 0;
      while (requests.length > 0) {
        const { UnprocessedItems } = await ddb.send(
          new BatchWriteCommand({ RequestItems: { [table()]: requests } }),
        );
        const remaining = UnprocessedItems?.[table()] ?? [];
        deleted += requests.length - remaining.length;
        requests = remaining;
        if (requests.length > 0) {
          if (attempt >= 5)
            throw new Error(
              `deleteExecution: ${requests.length} rows still unprocessed after ${attempt} retries`,
            );
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          attempt += 1;
        }
      }
    }
    return { deleted };
  };

  return {
    createExecution,
    getExecution,
    updateExecution,
    deleteExecution,
    putStage,
    getStage,
    updateStageState,
    resumeStageRow,
    appendEvent,
    createHumanTask,
    getHumanTask,
    setGateCallbackId,
    answerHumanTask,
    supersedeHumanTask,
    markGateRevised,
    createSteering,
    listSteering,
    listPendingSteering,
    markSteeringConsumed,
    supersedeSteering,
    resetStageRow,
    recordMetric,
    recordGraphRead,
    recordSensorRun,
    appendOutput,
    getOutputs,
    listProjectExecutions,
    patchExecutionConfig,
    putUnitPlan,
    getUnitPlan,
    getUnit,
    listUnits,
    syncUnitRows,
    updateUnitState,
    updateUnitPlanDecisions,
    getExecutionRecords,
  };
};

export { createProcessStore };
export default { createProcessStore };
