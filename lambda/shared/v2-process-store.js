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
  ScanCommand,
  TransactWriteCommand,
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
  unitPrKey,
  feedbackBatchKey,
  unitLaneId,
  quorumEditKey,
  composeKey,
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
  buildUnitPrRow,
  buildFeedbackBatchRow,
  buildFeedbackCommentRow,
  buildQuorumEditRow,
  buildComposeRow,
  UNIT_STATES,
  UNIT_PR_STATES,
  FEEDBACK_STATES,
  QUORUM_EDIT_STATES,
  COMPOSE_STATES,
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

const scanAll = async (ddb, input) => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({ ...input, ExclusiveStartKey }));
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
    durableExecutionName,
    durableExecutionArn,
    orchestratorStartedAt,
    orchestratorExpiresAt,
    rewindFromStageId,
    currentPhase,
    currentStage,
    pendingHumanTaskId,
    startedAt,
    completedAt,
    failureReason,
    startedBy,
    starterName,
    starterEmail,
    constructionAutonomyMode,
    // Per-intent skip overlay (stage-skip.js). Only the rewind endpoint writes
    // this: rewinding TO a skipped stage UN-skips it (list shrinks, or null).
    skipStageIds,
    // Per-intent composed EXECUTE/SKIP grid. Written at DRAFT start (launch
    // override) and by the recompose path (which retires + relaunches the
    // run). Validated shape only — the plan resolver owns grid policy.
    composedGrid,
    // DRAFT-phase editable header fields (the collaborative draft page's
    // auto-save writes these). The intents API only routes them while the
    // intent is DRAFT; the store validates shape, not lifecycle.
    title,
    prompt,
    scope,
    planWarnings,
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
    if (startedBy !== undefined) {
      sets.push('startedBy = :sby');
      values[':sby'] = startedBy;
    }
    if (starterName !== undefined) {
      sets.push('starterName = :snm');
      values[':snm'] = starterName;
    }
    if (starterEmail !== undefined) {
      sets.push('starterEmail = :sem');
      values[':sem'] = starterEmail;
    }
    if (orchestratorRunId !== undefined) {
      sets.push('orchestratorRunId = :orid');
      values[':orid'] = orchestratorRunId;
    }
    if (durableExecutionName !== undefined) {
      sets.push('durableExecutionName = :den');
      values[':den'] = durableExecutionName;
    }
    if (durableExecutionArn !== undefined) {
      sets.push('durableExecutionArn = :dea');
      values[':dea'] = durableExecutionArn;
    }
    if (orchestratorStartedAt !== undefined) {
      sets.push('orchestratorStartedAt = :osa');
      values[':osa'] = orchestratorStartedAt;
    }
    if (orchestratorExpiresAt !== undefined) {
      sets.push('orchestratorExpiresAt = :oea');
      values[':oea'] = orchestratorExpiresAt;
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
    // Per-intent skip overlay (stage-skip.js): a rewind to a skipped stage
    // un-skips it. Validated shape only — the plan resolver owns the policy.
    if (skipStageIds !== undefined) {
      if (skipStageIds !== null && !Array.isArray(skipStageIds)) {
        throw new Error('skipStageIds must be an array of stage ids or null');
      }
      sets.push('skipStageIds = :ssi');
      values[':ssi'] = skipStageIds && skipStageIds.length ? skipStageIds : null;
    }
    if (composedGrid !== undefined) {
      if (
        composedGrid !== null &&
        (typeof composedGrid !== 'object' || Array.isArray(composedGrid))
      ) {
        throw new Error('composedGrid must be a {stageId: EXECUTE|SKIP} object or null');
      }
      sets.push('composedGrid = :cgr');
      values[':cgr'] = composedGrid && Object.keys(composedGrid).length ? composedGrid : null;
    }
    if (title !== undefined) {
      if (title !== null && typeof title !== 'string') {
        throw new Error('title must be a string or null');
      }
      sets.push('title = :ttl');
      values[':ttl'] = title;
    }
    if (prompt !== undefined) {
      if (prompt !== null && typeof prompt !== 'string') {
        throw new Error('prompt must be a string or null');
      }
      sets.push('prompt = :prm');
      values[':prm'] = prompt;
    }
    if (scope !== undefined) {
      if (typeof scope !== 'string' || !scope) {
        throw new Error('scope must be a non-empty string');
      }
      sets.push('#scope = :scp');
      names['#scope'] = 'scope';
      values[':scp'] = scope;
    }
    if (planWarnings !== undefined) {
      sets.push('planWarnings = :pwn');
      values[':pwn'] = Array.isArray(planWarnings) && planWarnings.length ? planWarnings : null;
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
    pendingHumanTaskId,
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
    if (pendingHumanTaskId !== undefined) {
      sets.push('pendingHumanTaskId = :ph');
      values[':ph'] = pendingHumanTaskId;
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
      'pendingHumanTaskId = :null',
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
    sectionIndex,
    actor,
    summary,
    payloadRef,
  }) => {
    const item = buildEventRow({
      executionId,
      type,
      stageInstanceId,
      unitSlug,
      sectionIndex,
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
    sectionIndex,
    kind,
    prompt,
    options,
    questions,
    skipTargets,
    recomposeTargets,
    nextStageId,
    humanTaskId,
  }) => {
    const id = humanTaskId ?? nextId();
    const item = buildHumanTaskRow({
      executionId,
      humanTaskId: id,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      kind,
      prompt,
      options,
      questions,
      skipTargets,
      recomposeTargets,
      nextStageId,
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

  // Bind one durable callback to one pending gate owner. Concurrent lanes must
  // never overwrite each other's callback: a replay may repeat the identical
  // binding, but a different callback/owner fails the CAS and is surfaced by
  // the orchestrator as an invariant violation.
  const setGateCallbackId = async ({
    executionId,
    humanTaskId,
    callbackId,
    stageInstanceId,
    callbackOwner,
  }) => {
    const names = { '#status': 'status' };
    const values = {
      ':pending': 'pending',
      ':cb': callbackId,
      ':owner': callbackOwner ?? null,
      ':nullCallback': null,
      ':nullOwner': null,
    };
    const conditions = [
      '#status = :pending',
      '(attribute_not_exists(callbackId) OR callbackId = :nullCallback OR callbackId = :cb)',
      '(attribute_not_exists(callbackOwner) OR callbackOwner = :nullOwner OR callbackOwner = :owner)',
    ];
    if (stageInstanceId !== undefined) {
      conditions.push(
        stageInstanceId === null
          ? '(attribute_not_exists(stageInstanceId) OR stageInstanceId = :nullStage)'
          : 'stageInstanceId = :stageInstanceId',
      );
      if (stageInstanceId === null) values[':nullStage'] = null;
      else values[':stageInstanceId'] = stageInstanceId;
    }
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: humanTaskKey(executionId, humanTaskId),
          ConditionExpression: conditions.join(' AND '),
          UpdateExpression: 'SET callbackId = :cb, callbackOwner = :owner',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return Attributes;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
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
    // A previous rewind attempt may have reset this row before its caller
    // timed out. Treat a clean PENDING row as already reset so replay does not
    // inflate the attempt counter or duplicate reset events.
    if (
      existing.state === 'PENDING' &&
      existing.startedAt == null &&
      existing.cliSessionId == null &&
      existing.runtimeError == null
    ) {
      return null;
    }
    const ts = now();
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: stageKey(executionId, stageInstanceId),
        UpdateExpression:
          'SET #state = :state, attempt = :attempt, cli = :null, cliSessionId = :null, ' +
          'runtimeError = :null, startedAt = :null, completedAt = :null, ' +
          'parkedAt = :null, pendingHumanTaskId = :null, waitMs = :zero, ' +
          'updatedAt = :ts, GSI2SK = :g2sk',
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
    sectionIndex,
    metrics,
    resolvedModel = null,
    creditRate = null,
  }) => {
    const item = buildMetricRow({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
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
    sectionIndex,
    tool,
    bytes = 0,
    resultCount = null,
    args = {},
  }) => {
    const item = buildGraphReadRow({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
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
    sectionIndex,
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
      sectionIndex,
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

  const listSensorRuns = async (executionId, { stageInstanceId } = {}) => {
    const rows = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'SENSOR#' },
    });
    return rows
      .filter((r) => !stageInstanceId || r.stageInstanceId === stageInstanceId)
      .toSorted(bySk);
  };

  // Append an agent output chunk for restore-on-reload. The sequence is an atomic
  // counter on the META row (ADD), so concurrent chunks never collide and SK sort
  // == emit order. The live copy is broadcast over the websocket by the caller.
  const appendOutput = async ({
    executionId,
    stageInstanceId,
    unitSlug,
    sectionIndex,
    kind = 'text',
    content,
    display = null,
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
      sectionIndex,
      seq,
      kind,
      content,
      display,
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

  const listStaleActiveExecutions = async ({
    statuses = ['WAITING', 'RUNNING'],
    nowIso,
    timeoutSeconds,
    limit = 100,
  } = {}) => {
    const nowMs = Date.parse(nowIso ?? now());
    const timeoutMs = Number(timeoutSeconds) * 1000;
    const legacyCutoff =
      Number.isFinite(nowMs) && Number.isFinite(timeoutMs)
        ? new Date(nowMs - timeoutMs).toISOString()
        : null;
    const statusSet = new Set(statuses);
    const rows = await scanAll(ddb, {
      TableName: table(),
      FilterExpression: 'sk = :meta',
      ExpressionAttributeValues: { ':meta': META },
    });
    return rows
      .filter((row) => statusSet.has(row.status))
      .filter((row) => {
        if (row.orchestratorExpiresAt) return row.orchestratorExpiresAt <= (nowIso ?? now());
        return legacyCutoff ? (row.orchestratorStartedAt ?? row.startedAt) <= legacyCutoff : false;
      })
      .slice(0, limit);
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
    repoProviders,
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
    maybe('repoProviders', ':repoProviders', repoProviders);
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

  const getUnit = async (executionId, sectionIndexOrSlug, maybeSlug) => {
    // Legacy two-argument form reads the old slug-only key directly.
    if (maybeSlug === undefined) {
      const { Item } = await ddb.send(
        new GetCommand({ TableName: table(), Key: unitKey(executionId, sectionIndexOrSlug) }),
      );
      return Item ?? null;
    }
    const sectionIndex = sectionIndexOrSlug;
    const slug = maybeSlug;
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: unitKey(executionId, sectionIndex, slug) }),
    );
    if (Item) return Item;
    // Backward read: executions created before section-aware keys have a
    // single UNIT#<slug> row. Never rewrite it during a read.
    const { Item: legacy } = await ddb.send(
      new GetCommand({ TableName: table(), Key: unitKey(executionId, slug) }),
    );
    return legacy ?? null;
  };

  // The append-only audit trail (SK prefix EVENT#, time-ordered). The PR
  // fan-in reads this to decide whether repo work happened during the run
  // (v2.git.pushed / v2.git.push_failed) before trusting a "no changes"
  // comparison. Paginated — a dropped page could hide a push failure.
  const listEvents = async (executionId) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'EVENT#' },
    });
    return items.toSorted(bySk);
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
  const syncUnitRows = async ({ executionId, units, batches = [], sectionIndexes = [null] }) => {
    const batchIndexOf = (slug) => {
      const i = batches.findIndex((b) => b.includes(slug));
      return i < 0 ? 0 : i;
    };
    const existing = await listUnits(executionId);
    const laneIdOf = (row) => unitLaneId(row.sectionIndex ?? null, row.slug);
    const byLane = new Map(existing.map((r) => [laneIdOf(r), r]));
    const created = [];
    const updated = [];
    const preserved = [];
    for (const sectionIndex of sectionIndexes.length ? sectionIndexes : [null]) {
      for (const u of units) {
        const slug = u.slug ?? u.name;
        const dependsOn = u.dependsOn ?? u.depends_on ?? [];
        const kind = u.kind ?? null;
        const id = unitLaneId(sectionIndex, slug);
        const row = byLane.get(id);
        const label = sectionIndex == null ? slug : `s${sectionIndex}:${slug}`;
        if (!row) {
          const item = buildUnitRow({
            executionId,
            sectionIndex,
            slug,
            dependsOn,
            kind,
            state: 'PENDING',
            batchIndex: batchIndexOf(slug),
            now: now(),
          });
          await ddb.send(new PutCommand({ TableName: table(), Item: item }));
          created.push(label);
          continue;
        }
        if (row.state === 'PENDING' || row.state === 'READY') {
          const ts = now();
          await ddb.send(
            new UpdateCommand({
              TableName: table(),
              Key: unitKey(executionId, sectionIndex, slug),
              UpdateExpression:
                'SET dependsOn = :deps, kind = :kind, batchIndex = :bi, #state = :state, updatedAt = :ts, GSI2SK = :g2sk',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: {
                ':deps': dependsOn,
                ':kind': kind,
                ':bi': batchIndexOf(slug),
                ':state': 'PENDING',
                ':ts': ts,
                ':g2sk': executionTypeStateIndex({
                  executionId,
                  type: 'UNIT',
                  state: 'PENDING',
                  id,
                }).GSI2SK,
              },
            }),
          );
          updated.push(label);
        } else {
          preserved.push(label);
        }
      }
    }
    const dagSlugs = new Set(units.map((u) => u.slug ?? u.name));
    const sections = new Set(sectionIndexes.map((v) => v ?? null));
    const orphaned = existing
      .filter((r) => sections.has(r.sectionIndex ?? null) && !dagSlugs.has(r.slug))
      .map((r) => (r.sectionIndex == null ? r.slug : `s${r.sectionIndex}:${r.slug}`));
    return { created, updated, preserved, orphaned };
  };

  // Lane state transition, CAS'd on the expected prior state(s) so concurrent
  // lanes (WP5) can never double-start or clobber a terminal verdict. Returns
  // the new row, or null when the CAS lost. Extra lifecycle fields are stamped
  // by name (branch, sessionId, startedAt, mergedAt, failureReason, blockedOn).
  const updateUnitState = async ({
    executionId,
    sectionIndex = null,
    slug,
    state,
    fromStates = null,
    fields = {},
  }) => {
    if (!UNIT_STATES.includes(state)) throw new Error(`invalid unit state: ${state}`);
    const ts = now();
    const sets = ['#state = :state', 'updatedAt = :ts', 'GSI2SK = :g2sk'];
    const names = { '#state': 'state' };
    const values = {
      ':state': state,
      ':ts': ts,
      ':g2sk': executionTypeStateIndex({
        executionId,
        type: 'UNIT',
        state,
        id: unitLaneId(sectionIndex, slug),
      }).GSI2SK,
    };
    for (const [k, v] of Object.entries(fields)) {
      names[`#f_${k}`] = k;
      values[`:f_${k}`] = v === true && (k === 'startedAt' || k === 'mergedAt') ? ts : v;
      sets.push(`#f_${k} = :f_${k}`);
    }
    const params = {
      TableName: table(),
      Key: unitKey(executionId, sectionIndex, slug),
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

  // One provider PR/MR per changed repository for a section-specific unit.
  // Creation is conditional and returns the existing row on replay; callers
  // recover an exact provider-side PR before retrying this write.
  const createUnitPr = async (input) => {
    if (!UNIT_PR_STATES.includes(input.state ?? 'DRAFT')) {
      throw new Error(`invalid unit PR state: ${input.state}`);
    }
    const item = buildUnitPrRow({ ...input, now: now() });
    try {
      await ddb.send(
        new PutCommand({
          TableName: table(),
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
        }),
      );
      return item;
    } catch (e) {
      if (e?.name !== 'ConditionalCheckFailedException') throw e;
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: table(),
          Key: unitPrKey(input.executionId, input.sectionIndex, input.slug, input.repository),
        }),
      );
      return Item ?? null;
    }
  };

  const getUnitPr = async (executionId, sectionIndex, slug, repository) => {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: table(),
        Key: unitPrKey(executionId, sectionIndex, slug, repository),
      }),
    );
    return Item ?? null;
  };

  const listUnitPrs = async (executionId, { sectionIndex, slug } = {}) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'UNITPR#' },
    });
    return items
      .filter((row) => sectionIndex === undefined || row.sectionIndex === sectionIndex)
      .filter((row) => slug === undefined || row.unitSlug === slug)
      .toSorted(bySk);
  };

  const updateUnitPr = async ({
    executionId,
    sectionIndex,
    slug,
    repository,
    state,
    fromStates = null,
    fields = {},
  }) => {
    if (state !== undefined && !UNIT_PR_STATES.includes(state)) {
      throw new Error(`invalid unit PR state: ${state}`);
    }
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const names = {};
    const values = { ':ts': ts };
    if (state !== undefined) {
      names['#state'] = 'state';
      values[':state'] = state;
      values[':g2sk'] = executionTypeStateIndex({
        executionId,
        type: 'UNITPR',
        state,
        id: `${unitLaneId(sectionIndex, slug)}#${encodeURIComponent(repository)}`,
      }).GSI2SK;
      sets.push('#state = :state', 'GSI2SK = :g2sk');
      if (state === 'MERGED') {
        sets.push('mergedAt = :terminalAt');
        values[':terminalAt'] = ts;
      } else if (state === 'CLOSED') {
        sets.push('closedAt = :terminalAt');
        values[':terminalAt'] = ts;
      }
    }
    for (const [key, value] of Object.entries(fields)) {
      names[`#f_${key}`] = key;
      values[`:f_${key}`] = value;
      sets.push(`#f_${key} = :f_${key}`);
    }
    const params = {
      TableName: table(),
      Key: unitPrKey(executionId, sectionIndex, slug, repository),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
      ConditionExpression: 'attribute_exists(pk)',
    };
    if (Object.keys(names).length) params.ExpressionAttributeNames = names;
    if (Array.isArray(fromStates) && fromStates.length > 0) {
      params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, '#state': 'state' };
      params.ConditionExpression += ` AND #state IN (${fromStates
        .map((_, index) => `:from${index}`)
        .join(', ')})`;
      fromStates.forEach((value, index) => {
        params.ExpressionAttributeValues[`:from${index}`] = value;
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

  // Authenticated review selections. A deterministic batch id makes retries
  // idempotent; the row stores provider comment versions used for dispatch.
  const createFeedbackBatch = async (input) => {
    const ts = now();
    const item = buildFeedbackBatchRow({ ...input, now: ts });
    const claims = (input.comments ?? []).map((comment) =>
      buildFeedbackCommentRow({ ...input, comment, now: ts }),
    );
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [item, ...claims].map((row) => ({
            Put: {
              TableName: table(),
              Item: row,
              ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            },
          })),
        }),
      );
      return { item, created: true };
    } catch (e) {
      if (
        e?.name !== 'TransactionCanceledException' &&
        e?.name !== 'ConditionalCheckFailedException'
      ) {
        throw e;
      }
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: table(),
          Key: feedbackBatchKey(input.executionId, input.sectionIndex, input.slug, input.batchId),
        }),
      );
      return { item: Item ?? null, created: false, conflict: !Item };
    }
  };

  const listFeedbackBatches = async (executionId, { sectionIndex, slug, state } = {}) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'FEEDBACK#' },
    });
    return items
      .filter((row) => sectionIndex === undefined || row.sectionIndex === sectionIndex)
      .filter((row) => slug === undefined || row.unitSlug === slug)
      .filter((row) => state === undefined || row.state === state)
      .toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  };

  const updateFeedbackBatch = async ({
    executionId,
    sectionIndex,
    slug,
    batchId,
    state,
    fromStates = null,
    fields = {},
  }) => {
    if (!FEEDBACK_STATES.includes(state)) throw new Error(`invalid feedback state: ${state}`);
    const ts = now();
    const sets = ['#state = :state', 'updatedAt = :ts', 'GSI2SK = :g2sk'];
    const names = { '#state': 'state' };
    const values = {
      ':state': state,
      ':ts': ts,
      ':g2sk': executionTypeStateIndex({
        executionId,
        type: 'FEEDBACK',
        state,
        id: `${unitLaneId(sectionIndex, slug)}#${batchId}`,
      }).GSI2SK,
    };
    if (state === 'SUCCEEDED' || state === 'FAILED') {
      sets.push('completedAt = :completedAt');
      values[':completedAt'] = ts;
    }
    for (const [key, value] of Object.entries(fields)) {
      names[`#f_${key}`] = key;
      values[`:f_${key}`] = value;
      sets.push(`#f_${key} = :f_${key}`);
    }
    const params = {
      TableName: table(),
      Key: feedbackBatchKey(executionId, sectionIndex, slug, batchId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_NEW',
    };
    if (Array.isArray(fromStates) && fromStates.length > 0) {
      params.ConditionExpression += ` AND #state IN (${fromStates
        .map((_, index) => `:from${index}`)
        .join(', ')})`;
      fromStates.forEach((value, index) => {
        values[`:from${index}`] = value;
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

  // Patch human decisions captured at the fan-out approval (the unit-DAG stage gate) onto the UNITPLAN
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

  // ── Quorum-supported artifact edits (post-hoc document editing) ──

  // Open a new quorum edit session (state PLANNING). Conditional so an editId
  // can never be double-created.
  const createQuorumEdit = async (input) => {
    const item = buildQuorumEditRow({ ...input, now: now() });
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return item;
  };

  const getQuorumEdit = async (executionId, editId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: quorumEditKey(executionId, editId) }),
    );
    return Item ?? null;
  };

  // Lifecycle transition + field patch, CAS'd on the expected prior state(s)
  // so the human decision endpoint and the durable orchestrator can never
  // double-apply a transition (mirrors updateUnitState). `state` optional —
  // a fields-only patch (e.g. the container persisting the plan) skips the
  // GSI re-stamp. Returns the new row, or null when the CAS lost.
  const updateQuorumEdit = async ({
    executionId,
    editId,
    state,
    fromStates = null,
    fields = {},
  }) => {
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const names = {};
    const values = { ':ts': ts };
    if (state !== undefined) {
      if (!QUORUM_EDIT_STATES.includes(state))
        throw new Error(`invalid quorum edit state: ${state}`);
      names['#state'] = 'state';
      sets.push('#state = :state', 'GSI2SK = :g2sk');
      values[':state'] = state;
      values[':g2sk'] = executionTypeStateIndex({
        executionId,
        type: 'QEDIT',
        state,
        id: editId,
      }).GSI2SK;
    }
    for (const [k, v] of Object.entries(fields)) {
      names[`#f_${k}`] = k;
      values[`:f_${k}`] = v === true && (k === 'completedAt' || k === 'decidedAt') ? ts : v;
      sets.push(`#f_${k} = :f_${k}`);
    }
    const params = {
      TableName: table(),
      Key: quorumEditKey(executionId, editId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length) params.ExpressionAttributeNames = names;
    const conditions = ['attribute_exists(pk)'];
    if (Array.isArray(fromStates) && fromStates.length > 0) {
      params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, '#state': 'state' };
      conditions.push(`#state IN (${fromStates.map((_, i) => `:from${i}`).join(', ')})`);
      fromStates.forEach((s, i) => {
        params.ExpressionAttributeValues[`:from${i}`] = s;
      });
    }
    params.ConditionExpression = conditions.join(' AND ');
    try {
      const { Attributes } = await ddb.send(new UpdateCommand(params));
      return Attributes;
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  };

  // All quorum edit sessions for an execution, oldest first by editId sort.
  const listQuorumEdits = async (executionId) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'QEDIT#' },
    });
    return items.toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  };

  // ── Composer sessions (Adaptive Workflows) ──
  const createCompose = async (input) => {
    const item = buildComposeRow({ ...input, now: now() });
    await ddb.send(
      new PutCommand({
        TableName: table(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
      }),
    );
    return item;
  };

  const getCompose = async (executionId, composeId) => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName: table(), Key: composeKey(executionId, composeId) }),
    );
    return Item ?? null;
  };

  // Lifecycle transition + field patch, CAS'd on the expected prior state(s)
  // (mirrors updateQuorumEdit) so a crashed compose job retried by the
  // container can never double-complete a row. Returns the new row, or null
  // when the CAS lost.
  const updateCompose = async ({
    executionId,
    composeId,
    state,
    fromStates = null,
    fields = {},
  }) => {
    const ts = now();
    const sets = ['updatedAt = :ts'];
    const names = {};
    const values = { ':ts': ts };
    if (state !== undefined) {
      if (!COMPOSE_STATES.includes(state)) throw new Error(`invalid compose state: ${state}`);
      names['#state'] = 'state';
      sets.push('#state = :state', 'GSI2SK = :g2sk');
      values[':state'] = state;
      values[':g2sk'] = executionTypeStateIndex({
        executionId,
        type: 'COMPOSE',
        state,
        id: composeId,
      }).GSI2SK;
      if (state === 'COMPLETED' || state === 'FAILED') {
        sets.push('completedAt = :ca');
        values[':ca'] = ts;
      }
    }
    for (const [k, v] of Object.entries(fields)) {
      names[`#f_${k}`] = k;
      values[`:f_${k}`] = v;
      sets.push(`#f_${k} = :f_${k}`);
    }
    const params = {
      TableName: table(),
      Key: composeKey(executionId, composeId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length) params.ExpressionAttributeNames = names;
    const conditions = ['attribute_exists(pk)'];
    if (Array.isArray(fromStates) && fromStates.length > 0) {
      params.ExpressionAttributeNames = { ...params.ExpressionAttributeNames, '#state': 'state' };
      conditions.push(`#state IN (${fromStates.map((_, i) => `:from${i}`).join(', ')})`);
      fromStates.forEach((s, i) => {
        params.ExpressionAttributeValues[`:from${i}`] = s;
      });
    }
    params.ConditionExpression = conditions.join(' AND ');
    try {
      const { Attributes } = await ddb.send(new UpdateCommand(params));
      return Attributes;
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  };

  // All composer sessions for an execution, oldest first.
  const listComposes = async (executionId) => {
    const items = await queryAll(ddb, {
      TableName: table(),
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': executionPk(executionId), ':p': 'COMPOSE#' },
    });
    return items.toSorted((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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
      unitPrs: records.filter((r) => r.sk.startsWith('UNITPR#')),
      feedbackBatches: records.filter((r) => r.sk.startsWith('FEEDBACK#')),
      quorumEdits: records.filter((r) => r.sk.startsWith('QEDIT#')),
      composes: records.filter((r) => r.sk.startsWith('COMPOSE#')),
    };
  };

  // Delete EVERY record for an execution — the whole EXEC#<id> partition
  // (META, STAGE#, EVENT#, HUMAN#, METRIC#, OUTPUT#, SENSOR#, STEER#,
  // QEDIT#, UNITPLAN, UNIT#). Keys-only projection: OUTPUT# rows can be megabytes and
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
    listEvents,
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
    listSensorRuns,
    appendOutput,
    getOutputs,
    listProjectExecutions,
    listStaleActiveExecutions,
    patchExecutionConfig,
    putUnitPlan,
    getUnitPlan,
    getUnit,
    listUnits,
    syncUnitRows,
    updateUnitState,
    createUnitPr,
    getUnitPr,
    listUnitPrs,
    updateUnitPr,
    createFeedbackBatch,
    listFeedbackBatches,
    updateFeedbackBatch,
    updateUnitPlanDecisions,
    createQuorumEdit,
    getQuorumEdit,
    updateQuorumEdit,
    listQuorumEdits,
    createCompose,
    getCompose,
    updateCompose,
    listComposes,
    getExecutionRecords,
  };
};

export { createProcessStore };
export default { createProcessStore };
