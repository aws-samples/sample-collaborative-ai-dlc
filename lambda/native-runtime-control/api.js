// Dedicated REST/Cognito boundary; invocation IAM must exclude agent runtimes.
// No JWT/actor fallback or internal worker route.
import { buildResponse } from '../shared/response.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { ID, UUID_V4, fail, matches, nativeDraftRequest, pinPackageJob, record } from './store.js';
import { nativeListQuery } from './listing.js';
import { nativeDraftPrompt, nativePromptRequest, promptFailure } from './draft-prompt.js';
import { nativeRevisionQuery } from './revision-query.js';
import { nativeResultRequest, nativeResultQuery } from './result-store.js';
import { nativeUnavailableHarnesses } from './execution-api.js';
import { nativeReplyRequest } from './execution-store.js';

const COLLECTION = '/api/projects/{projectId}/native-intents';
const ITEM = `${COLLECTION}/{intentId}`;
const PREPARE = `${ITEM}/prepare`;
const PROMPT = `${ITEM}/prompt`;
const START = `${ITEM}/start`;
const CANCEL = `${ITEM}/cancel`;
const RECOVER = `${ITEM}/recover`;
const PUBLICATION = `${ITEM}/publication`;
const FILE = `${ITEM}/files/{fileId}`;
const GRAPH = `${ITEM}/graph`;
const INTERACTION = `${ITEM}/interaction`;
const RESPONSE = `${ITEM}/response`;
const OUTPUTS = `${ITEM}/outputs`;
const RESULTS = `${ITEM}/results`;
const ERRORS = {
  NATIVE_RESULT_INVALID: [400, 'Invalid native result request'],
  NATIVE_RESULT_CONFLICT: [409, 'The result request names different immutable bytes'],
  NATIVE_RESULT_UNAVAILABLE: [
    503,
    'The result download could not be verified. Retry the same request',
  ],
  NATIVE_RESULT_FILE_POLICY: [
    409,
    'This result contains files restricted by the existing export policy. No partial archive is provided',
  ],
  NATIVE_RESULT_ARCHIVE_PATH: [
    409,
    'These exact paths cannot be safely represented in a portable archive. Download eligible files individually',
  ],
  NATIVE_ARTIFACT_REVISION_INVALID: [
    404,
    'The named native revision is unavailable or could not be verified',
  ],
  NATIVE_PROMPT_INVALID: [400, 'Enter a nonblank prompt of at most 64 KiB without null characters'],
  NATIVE_PROMPT_CONFLICT: [
    409,
    'The prompt or native intent changed. Refresh before editing or starting',
  ],
  NATIVE_PROMPT_UNAVAILABLE: [503, 'Prompt saving could not be confirmed. Retry the same save'],
  NATIVE_PREPARATION_INVALID: [400, 'Invalid native preparation request'],
  NATIVE_PREPARATION_BODY_TOO_LARGE: [413, 'Native draft request is too large'],
  NATIVE_PREPARATION_CONFLICT: [409, 'Native intent changed or its immutable request conflicts'],
  NATIVE_PREPARATION_NOT_FOUND: [404, 'Native intent not found'],
  NATIVE_PREPARATION_UNAVAILABLE: [503, 'Native preparation is unavailable; retry safely'],
  NATIVE_PREPARATION_PACKAGE_INVALID: [409, 'A matching completed package import is required'],
  NATIVE_PREPARATION_FORBIDDEN: [403, 'Native intent access denied'],
  WORKFLOW_SOURCE_INVALID: [409, 'Workflow source must be reverified'],
  WORKFLOW_SOURCE_FORBIDDEN: [403, 'Workflow source access denied'],
  WORKFLOW_SOURCE_CONFLICT: [409, 'Workflow source changed; reload before retrying'],
  WORKFLOW_SOURCE_NOT_FOUND: [404, 'Workflow source not found'],
  WORKFLOW_SOURCE_UNAVAILABLE: [503, 'Workflow source service unavailable'],
  native_package_job_invalid: [409, 'Package import state is invalid'],
  native_package_job_not_found: [404, 'Package import not found'],
  native_package_job_unavailable: [503, 'Package import service unavailable'],
  NATIVE_EXECUTION_DISABLED: [503, 'Native execution is disabled'],
  NATIVE_EXECUTION_KIRO_UNAVAILABLE: [
    409,
    'Kiro is temporarily unavailable for new native executions while AI-DLC input and authentication qualification is pending. Choose Claude Code, Codex or OpenCode.',
  ],
  NATIVE_EXECUTION_INVALID: [400, 'Invalid native execution request'],
  NATIVE_EXECUTION_CONFLICT: [409, 'Native execution changed; refresh its status'],
  NATIVE_EXECUTION_NOT_FOUND: [404, 'Native execution not found'],
  NATIVE_EXECUTION_UNAVAILABLE: [503, 'Native execution is unavailable; retry the same request'],
  NATIVE_EXECUTION_FORBIDDEN: [403, 'Native execution access denied'],
  NATIVE_EXECUTION_CREDENTIAL_REQUIRED: [
    409,
    'No credential is configured for the selected harness',
  ],
  NATIVE_EXECUTION_REPOSITORY_REQUIRED: [409, 'A connected application repository is required'],
  NATIVE_EXECUTION_REPOSITORY_AMBIGUOUS: [
    409,
    'The first native execution requires one application repository',
  ],
  NATIVE_EXECUTION_SOURCE_CHANGED: [
    409,
    'The repository binding changed; verify it before starting',
  ],
  NATIVE_EXECUTION_NOT_READY: [409, 'Prepare the native workspace before starting'],
  NATIVE_EXECUTION_LEASE_LOST: [409, 'Native execution ownership changed; refresh its status'],
  NATIVE_EXECUTION_CANCELLED: [409, 'Native execution was cancelled'],
  NATIVE_EXECUTION_IMAGE_REVOKED: [409, 'The runtime image for this execution was revoked'],
  NATIVE_EXECUTION_IMAGE_UNAPPROVED: [409, 'The runtime image is no longer approved'],
  NATIVE_EXECUTION_CONFIG_INVALID: [409, 'Native execution configuration is invalid'],
  NATIVE_EXECUTION_CONFIG_UNAVAILABLE: [503, 'Native execution configuration is unavailable'],
  agent_cli_disabled: [400, 'The selected agent CLI is disabled by the platform administrator'],
  NATIVE_EXECUTION_CONFIG_NOT_READY: [409, 'Prepare the native workspace before starting'],
  NATIVE_EXECUTION_CONFIG_PROMPT_REQUIRED: [409, 'Add a prompt before starting native execution'],
  NATIVE_EXECUTION_CONFIG_PROJECT_CHANGED: [409, 'The project changed; reload before starting'],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_REQUIRED: [
    409,
    'Link one application repository in project source-control settings',
  ],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_AMBIGUOUS: [
    409,
    'The first native milestone requires exactly one application repository',
  ],
  NATIVE_EXECUTION_CONFIG_REPOSITORY_INVALID: [
    409,
    'Verify the application repository provider and identity',
  ],
  NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_REQUIRED: [
    409,
    'Verify the application repository source-control binding before starting',
  ],
  NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_CHANGED: [
    409,
    'The application repository binding changed; reload before starting',
  ],
  NATIVE_EXECUTION_CONFIG_CREDENTIAL_REQUIRED: [
    409,
    'Configure a credential for the selected coding harness before starting',
  ],
  NATIVE_EXECUTION_CONFIG_CREDENTIAL_INVALID: [
    409,
    'The selected coding harness credential binding could not be verified',
  ],
  NATIVE_PUBLICATION_NOT_FOUND: [404, 'No matching native publication or file exists'],
  NATIVE_PUBLICATION_INVALID: [503, 'Native published bytes could not be verified'],
  NATIVE_INTERACTION_NOT_FOUND: [404, 'No completed native interaction exists'],
  NATIVE_INTERACTION_INVALID: [503, 'Native interaction could not be verified'],
  NATIVE_FILE_TOO_LARGE: [413, 'This file is too large for the inline viewer'],
};
const reply = (response, status, code, error) => response(status, { code, error });
export const nativePreparationInternalError = (event) =>
  reply(
    buildResponse(event, { methods: 'GET,POST,OPTIONS' }),
    500,
    'NATIVE_PREPARATION_INTERNAL_ERROR',
    'Native preparation request failed',
  );

export const nativeIntentView = (row) => ({
  id: row.executionId,
  projectId: row.projectId,
  executionBackend: 'native',
  title: row.request.title,
  prompt: nativeDraftPrompt(row).text,
  promptRevision: nativeDraftPrompt(row).revision,
  harness: row.harness,
  ...(row.request.applicationSource
    ? { applicationSource: { ...row.request.applicationSource } }
    : {}),
  status: row.status,
  package: {
    version: row.candidate.packagePin.version,
    source: {
      provider: row.candidate.packagePin.source.provider,
      repository: row.candidate.packagePin.source.repository,
      release: row.candidate.packagePin.source.release,
    },
  },
  ...(row.status === 'FAILED' ? { failureCode: row.failureCode } : {}),
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

export const nativeIntentSummary = (row) => {
  const summary = nativeIntentView(row);
  delete summary.prompt;
  delete summary.promptRevision;
  delete summary.applicationSource;
  return summary;
};

const validMembership = (value) =>
  record(value) &&
  ['owner', 'admin', 'member'].includes(value.role) &&
  ['membershipId', 'projectIdentity'].every(
    (key) =>
      typeof value[key] === 'string' &&
      value[key].length > 0 &&
      value[key].length <= 512 &&
      value[key].trim() === value[key] &&
      ![...value[key]].some((character) => character.codePointAt(0) < 32 || character === '\x7f'),
  );

const fields = (value, names) =>
  record(value) &&
  Object.keys(value).length === names.length &&
  names.every((key) => Object.hasOwn(value, key));
const startRequest = (value) => {
  if (
    !fields(value, ['requestId', 'promptRevision']) ||
    !matches(value.requestId, UUID_V4) ||
    !Number.isSafeInteger(value.promptRevision) ||
    value.promptRevision < 0
  )
    fail('INVALID');
  return value;
};
const recoveryRequest = (value) => {
  if (
    !fields(value, ['requestId', 'recoveryId', 'confirmWorkspaceResume']) ||
    !matches(value.requestId, UUID_V4) ||
    !matches(value.recoveryId, UUID_V4) ||
    value.confirmWorkspaceResume !== true
  )
    fail('INVALID');
  return value;
};
const jsonBody = (event, validate, maxBytes = 1024) => {
  if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > maxBytes) fail('INVALID');
  try {
    return validate(JSON.parse(event.body));
  } catch (error) {
    if (error?.code === 'NATIVE_PROMPT_INVALID') throw error;
    fail('INVALID');
  }
};
const draftBody = (event) => {
  // This marker identifies rejection before dependencies or persistence. It
  // says nothing about an earlier uncertain attempt with the same identity.
  try {
    if (typeof event.body === 'string' && Buffer.byteLength(event.body) > 96 * 1024)
      throw Object.assign(new Error('Native draft request is too large'), {
        code: 'NATIVE_PREPARATION_BODY_TOO_LARGE',
      });
    return jsonBody(event, nativeDraftRequest, 96 * 1024);
  } catch (error) {
    error.draftInputRejected = true;
    throw error;
  }
};
const promptBody = (event) => {
  if (typeof event.body !== 'string' || Buffer.byteLength(event.body) > 96 * 1024)
    promptFailure('INVALID');
  return jsonBody(event, nativePromptRequest, 96 * 1024);
};
const emptyBody = (event) => {
  if (event.body == null || event.body === '') return {};
  return jsonBody(event, (value) => {
    if (!fields(value, [])) fail('INVALID');
    return value;
  });
};
const noBody = (event) => {
  if (event.body != null && event.body !== '') fail('INVALID');
};
const pathParameters = (event) => {
  const patterns = { projectId: ID, intentId: UUID_V4, fileId: /^nf-[a-f0-9]{64}$/ };
  const names = [...event.resource.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const params = event.pathParameters;
  if (
    !fields(params, names) ||
    names.some((name) => !matches(params[name], patterns[name])) ||
    ['operation', 'op', 'action'].some((key) => Object.hasOwn(event, key)) ||
    (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
  )
    fail('INVALID');
  const expected = event.resource.replace(/\{(\w+)\}/g, (_, name) => params[name]);
  if (event.path !== undefined && event.path !== expected) fail('INVALID');
  return params;
};
const outputCursor = (event, field = 'afterSeq') => {
  let after = 0;
  {
    const single = event.queryStringParameters ?? {};
    const multi = event.multiValueQueryStringParameters ?? {};
    if (
      !record(single) ||
      !record(multi) ||
      Object.keys(single).some((k) => !['afterSeq', 'afterEvent'].includes(k)) ||
      Object.entries(multi).some(
        ([k, v]) =>
          !['afterSeq', 'afterEvent'].includes(k) ||
          !Array.isArray(v) ||
          v.length !== 1 ||
          (single[k] !== undefined && single[k] !== v[0]),
      )
    )
      fail('INVALID');
    const raw = single[field] ?? multi[field]?.[0] ?? (field === 'afterEvent' ? undefined : '0');
    if (raw === undefined) return undefined;
    if (
      typeof raw !== 'string' ||
      !/^(0|[1-9][0-9]{0,15})$/.test(raw) ||
      !Number.isSafeInteger(Number(raw))
    )
      fail('INVALID');
    after = Number(raw);
  }
  return after;
};
export const createNativeRuntimeApi = ({
  enabled = false,
  admissionEnabled = enabled,
  allowedProjectIds = [],
  store,
  workflowSources,
  jobs,
  getMembershipSnapshot,
  listNativeIntents,
  enqueue,
  image,
  execution,
} = {}) => {
  const authorize = async (projectId, actorId) => {
    const membership = async () => {
      const current = await getMembershipSnapshot(projectId, actorId);
      if (!validMembership(current)) fail('FORBIDDEN');
      return structuredClone(current);
    };
    const before = await membership();
    const recheck = async (row = null) => {
      const current = await membership();
      if (
        current.projectIdentity !== before.projectIdentity ||
        current.membershipId !== before.membershipId ||
        (row && row.projectIdentity !== current.projectIdentity)
      )
        fail('FORBIDDEN');
    };
    return { before, recheck };
  };
  const authorizeSource = ({ projectId, actorId }, request) =>
    workflowSources.getAuthorizedBinding({
      projectId,
      actorId,
      sourceId: request.sourceId,
      expectedRevision: request.bindingRevision,
    });
  const readPins = async (context, request) => {
    const binding = await authorizeSource(context, request);
    const job = await jobs.get({ projectId: context.projectId, jobId: request.packageJobId });
    const pins = pinPackageJob(job, { projectId: context.projectId, request, binding });
    // No credential reads: recheck the protected source and membership after
    // package lookup, before persisting or enqueueing work.
    await authorizeSource(context, request);
    await context.recheck();
    return pins;
  };
  const collectionRead = async ({ query, projectId, before, recheck, response }) => {
    if (query) {
      const page = await listNativeIntents({
        projectId,
        projectIdentity: before.projectIdentity,
        ...query,
      });
      if (page.rows.some((row) => row.projectIdentity !== before.projectIdentity))
        fail('FORBIDDEN');
      await recheck();
      return response(200, {
        items: page.rows.map(nativeIntentSummary),
        nextCursor: page.nextCursor,
      });
    }
    const unavailableHarnesses = execution?.availability
      ? await execution.availability()
      : nativeUnavailableHarnesses;
    await recheck();
    return response(200, {
      preparationEnabled: admissionEnabled === true,
      executionEnabled: execution?.enabled === true,
      unavailableHarnesses,
    });
  };
  const createDraft = async (context) => {
    const { input, projectId, actorId, before, recheck, response } = context;
    if (!admissionEnabled && !(await store.get({ projectId, executionId: input.intentId })))
      return reply(response, 503, 'NATIVE_PREPARATION_DISABLED', 'New native drafts are disabled');
    const pins = await readPins(context, input);
    const created = await store.create({
      projectId,
      actorId,
      projectIdentity: before.projectIdentity,
      request: input,
      ...pins,
      image,
    });
    await recheck(created.row);
    return response(created.created ? 201 : 200, nativeIntentView(created.row));
  };
  const details = async (row, recheck) => ({
    ...nativeIntentView(row),
    ...(execution ? await execution.status(row, recheck) : {}),
  });
  const prepare = async (context) => {
    const { row, identity, recheck, response } = context;
    const pins = await readPins(context, row.request);
    if (
      canonicalJson(pins.candidate) !== canonicalJson(row.candidate) ||
      canonicalJson(pins.archiveReceipt) !== canonicalJson(row.archiveReceipt)
    )
      fail('CONFLICT');
    const prepared = await store.prepare(identity);
    await authorizeSource(context, prepared.request);
    await recheck(prepared);
    if (prepared.status === 'PREPARING') {
      // Commit first. Stream delivery repairs a lost fast notification; a
      // retry sends the same pointer without minting another execution.
      try {
        await enqueue(identity);
      } catch {
        /* Committed preparation remains discoverable. */
      }
    }
    return response(prepared.status === 'PREPARING' ? 202 : 200, await details(prepared, recheck));
  };
  const savePrompt = async ({ identity, actorId, before, input, recheck, response }) => {
    const saved = await store.savePrompt({
      ...identity,
      actorId,
      projectIdentity: before.projectIdentity,
      request: input,
    });
    await recheck(saved.row);
    return response(200, {
      ...(await details(saved.row, recheck)),
      promptAcceptance: saved.promptAcceptance,
    });
  };
  const commandResponse = async ({ row, response }, invoke) => {
    if (!execution)
      return reply(response, 503, 'NATIVE_EXECUTION_DISABLED', 'Native execution is disabled');
    return response(202, { ...nativeIntentView(row), ...(await invoke()) });
  };
  const committedRead = async ({ row, query, recheck, response }, read) => {
    if (!execution)
      return reply(
        response,
        404,
        'NATIVE_PUBLICATION_NOT_FOUND',
        'No native files have been published yet',
      );
    const result = await read();
    await recheck(row);
    return response(200, result, query?.evidence ? { 'Cache-Control': 'private, no-store' } : {});
  };
  const resultResponse = async ({ row, recheck, response }, read) => {
    if (!execution?.requestResult || !execution?.result)
      return reply(response, 503, 'NATIVE_RESULT_UNAVAILABLE', 'Result downloads are unavailable');
    const value = await read();
    await recheck(row);
    return response(value.status === 'ready' ? 200 : 202, value, {
      'Cache-Control': 'private, no-store',
    });
  };

  // Each public method owns its request and operation. Shared authentication,
  // path/body/query checks and membership rechecks surround this fixed table.
  const routes = {
    [COLLECTION]: {
      GET: {
        query: (event) =>
          nativeListQuery(event, { collection: true, projectId: event.pathParameters.projectId }),
        handle: collectionRead,
      },
      POST: { body: draftBody, handle: createDraft },
    },
    [ITEM]: {
      GET: {
        handle: async ({ row, recheck, response }) => response(200, await details(row, recheck)),
      },
    },
    [PREPARE]: { POST: { body: emptyBody, handle: prepare } },
    [PROMPT]: { POST: { body: promptBody, handle: savePrompt } },
    [START]: {
      POST: {
        body: (event) => jsonBody(event, startRequest),
        handle: (context) =>
          commandResponse(context, () =>
            execution.start(
              context.row,
              context.actorId,
              context.input.requestId,
              context.recheck,
              context.input.promptRevision,
            ),
          ),
      },
    },
    [CANCEL]: {
      POST: {
        body: emptyBody,
        handle: (context) =>
          commandResponse(context, () => execution.cancel(context.row, context.recheck)),
      },
    },
    [RECOVER]: {
      POST: {
        body: (event) => jsonBody(event, recoveryRequest),
        handle: (context) =>
          commandResponse(context, () =>
            execution.recover(context.row, context.input, context.recheck),
          ),
      },
    },
    [RESPONSE]: {
      POST: {
        // JSON escaping can expand a valid 16 KiB reply sixfold. The shared
        // request validator bounds decoded text and its optional selection.
        body: (event) => jsonBody(event, nativeReplyRequest, 100 * 1024),
        handle: (context) =>
          commandResponse(context, () =>
            execution.respond(context.row, context.actorId, context.input, context.recheck, {
              membershipId: context.before.membershipId,
              projectIdentity: context.before.projectIdentity,
            }),
          ),
      },
    },
    [OUTPUTS]: {
      GET: {
        query: (event) => ({
          after: outputCursor(event),
          afterEvent: outputCursor(event, 'afterEvent'),
        }),
        handle: async ({ row, query, recheck, response }) =>
          response(
            200,
            execution?.outputs
              ? await execution.outputs(row, query.after, recheck, query.afterEvent)
              : { outputs: [], nextAfter: null },
          ),
      },
    },
    [PUBLICATION]: {
      GET: {
        query: (event) => nativeRevisionQuery(event, 'publication'),
        handle: (context) =>
          committedRead(context, () =>
            context.query?.history
              ? execution.history(context.row, context.query.before, context.recheck)
              : context.query
                ? execution.revision(context.row, context.query, context.recheck)
                : execution.publication(context.row, context.recheck),
          ),
      },
    },
    [FILE]: {
      GET: {
        query: (event) => nativeRevisionQuery(event, 'file'),
        handle: (context) =>
          committedRead(context, () =>
            context.query
              ? execution.revisionFile(context.row, context.query, context.recheck)
              : execution.file(context.row, context.params.fileId, context.recheck),
          ),
      },
    },
    [INTERACTION]: {
      GET: {
        query: (event) => nativeRevisionQuery(event, 'interaction'),
        handle: (context) =>
          committedRead(context, () =>
            context.query
              ? execution.revisionInteraction(context.row, context.query, context.recheck)
              : execution.interaction(context.row, context.recheck),
          ),
      },
    },
    [GRAPH]: {
      GET: {
        handle: (context) =>
          committedRead(context, () => execution.graph(context.row, context.recheck)),
      },
    },
    [RESULTS]: {
      GET: {
        query: nativeResultQuery,
        handle: (context) =>
          resultResponse(context, () =>
            execution.result(context.row, context.query, context.recheck),
          ),
      },
      POST: {
        body: (event) => jsonBody(event, nativeResultRequest),
        handle: (context) =>
          resultResponse(context, () =>
            execution.requestResult(context.row, context.input, context.recheck),
          ),
      },
    },
  };
  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,OPTIONS' });
    if (!Object.hasOwn(routes, event?.resource ?? ''))
      return reply(response, 404, 'NOT_FOUND', 'Route not found');
    const methods = routes[event.resource];
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    if (!Object.hasOwn(methods, event.httpMethod))
      return response(
        405,
        { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' },
        { Allow: [...Object.keys(methods), 'OPTIONS'].join(',') },
      );
    if (enabled !== true)
      return reply(response, 503, 'NATIVE_PREPARATION_DISABLED', 'Native preparation is disabled');
    const claims = event.requestContext?.authorizer?.claims;
    const actorId = record(claims) && Object.hasOwn(claims, 'sub') ? claims.sub : undefined;
    if (!matches(actorId, ID))
      return reply(response, 401, 'UNAUTHORIZED', 'Authentication required');
    try {
      const params = pathParameters(event);
      const { projectId, intentId } = params;
      if (
        !Array.isArray(allowedProjectIds) ||
        !allowedProjectIds.every((id) => matches(id, ID)) ||
        !allowedProjectIds.includes(projectId)
      )
        return reply(
          response,
          403,
          'NATIVE_PREPARATION_PROJECT_DISABLED',
          'Native preparation is not enabled for this project',
        );
      const route = methods[event.httpMethod];
      const query = route.query
        ? route.query(event)
        : nativeListQuery(event, { collection: false, projectId });
      const input = (route.body ?? noBody)(event);
      const { before, recheck } = await authorize(projectId, actorId);
      const identity = intentId ? { projectId, executionId: intentId } : null;
      const row = identity ? await store.get(identity) : null;
      if (identity) {
        if (!row) fail('NOT_FOUND');
        await recheck(row);
      }
      return await route.handle({
        projectId,
        actorId,
        params,
        identity,
        row,
        input,
        query,
        before,
        recheck,
        response,
      });
    } catch (error) {
      const code =
        error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
      if (typeof code === 'string' && Object.hasOwn(ERRORS, code)) {
        const [status, message] = ERRORS[code];
        return response(status, {
          code,
          error: message,
          ...(error.draftInputRejected === true ? { draftInputRejected: true } : {}),
        });
      }
      return nativePreparationInternalError(event);
    }
  };
};
