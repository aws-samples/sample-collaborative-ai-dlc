// Dedicated REST/Cognito boundary; invocation IAM must exclude agent runtimes.
// No JWT/actor fallback or internal worker route.
import { buildResponse } from '../shared/response.js';
import { canonicalJson } from '../shared/workflow-checkpoint.js';
import { ID, UUID_V4, fail, matches, nativeDraftRequest, pinPackageJob, record } from './store.js';
import { nativeListQuery } from './listing.js';
import { NATIVE_INTERACTION_LIMITS } from '../shared/native-interaction.js';

const COLLECTION = '/api/projects/{projectId}/native-intents';
const ITEM = `${COLLECTION}/{intentId}`;
const PREPARE = `${ITEM}/prepare`;
const START = `${ITEM}/start`;
const CANCEL = `${ITEM}/cancel`;
const RECOVER = `${ITEM}/recover`;
const PUBLICATION = `${ITEM}/publication`;
const FILE = `${ITEM}/files/{fileId}`;
const GRAPH = `${ITEM}/graph`;
const INTERACTION = `${ITEM}/interaction`;
const RESPONSE = `${ITEM}/response`;
const OUTPUTS = `${ITEM}/outputs`;
const ERRORS = {
  NATIVE_PREPARATION_INVALID: [400, 'Invalid native preparation request'],
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
  prompt: row.request.prompt,
  harness: row.harness,
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

// Task-3: an optional structured selection. Its meaning is validated against
// the committed interaction by the execution API, not here.
const validReply = (value) =>
  record(value) &&
  Object.keys(value).length === (Object.hasOwn(value, 'selection') ? 5 : 4) &&
  ['requestId', 'interactionId', 'contentSha256', 'text'].every((key) =>
    Object.hasOwn(value, key),
  ) &&
  (!Object.hasOwn(value, 'selection') || record(value.selection)) &&
  matches(value.requestId, UUID_V4) &&
  matches(value.interactionId, /^[a-f0-9]{64}$/) &&
  matches(value.contentSha256, /^[a-f0-9]{64}$/) &&
  typeof value.text === 'string' &&
  Boolean(value.text.trim()) &&
  Buffer.byteLength(value.text) <= NATIVE_INTERACTION_LIMITS.responseBytes &&
  // oxlint-disable-next-line no-control-regex -- Reject terminal controls; preserve tabs and line endings.
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.text) &&
  Buffer.from(value.text, 'utf8').toString('utf8') === value.text;

const suffixFor = (resource, params) => {
  if (resource === COLLECTION || resource === ITEM) return '';
  if (resource === FILE) return `/files/${params.fileId}`;
  return '/' + resource.split('/').at(-1);
};
const outputCursor = (event) => {
  let after = 0;
  {
    const single = event.queryStringParameters ?? {};
    const multi = event.multiValueQueryStringParameters ?? {};
    if (
      !record(single) ||
      !record(multi) ||
      Object.keys(single).some((k) => k !== 'afterSeq') ||
      Object.entries(multi).some(
        ([k, v]) =>
          k !== 'afterSeq' ||
          !Array.isArray(v) ||
          v.length !== 1 ||
          (single[k] !== undefined && single[k] !== v[0]),
      )
    )
      fail('INVALID');
    const raw = single.afterSeq ?? multi.afterSeq?.[0] ?? '0';
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
  const collectionRead = async ({ listing, projectId, before, recheck, response }) => {
    if (listing) {
      const page = await listNativeIntents({
        projectId,
        projectIdentity: before.projectIdentity,
        ...listing,
      });
      if (page.rows.some((row) => row.projectIdentity !== before.projectIdentity))
        fail('FORBIDDEN');
      await recheck();
      return response(200, {
        items: page.rows.map(nativeIntentSummary),
        nextCursor: page.nextCursor,
      });
    }
    await recheck();
    return response(200, {
      preparationEnabled: admissionEnabled === true,
      executionEnabled: execution?.enabled === true,
    });
  };
  const executionCommand = async ({
    start,
    userResponse,
    recover,
    row,
    actorId,
    input,
    recheck,
    before,
    response,
  }) => {
    if (!execution)
      return reply(response, 503, 'NATIVE_EXECUTION_DISABLED', 'Native execution is disabled');
    const details = start
      ? await execution.start(row, actorId, input.requestId, recheck)
      : userResponse
        ? await execution.respond(row, actorId, input, recheck, {
            membershipId: before.membershipId,
            projectIdentity: before.projectIdentity,
          })
        : recover
          ? await execution.recover(row, input, recheck)
          : await execution.cancel(row, recheck);
    return response(202, { ...nativeIntentView(row), ...details });
  };
  const committedRead = async ({ event, file, row, params, recheck, response }) => {
    if (!execution)
      return reply(
        response,
        404,
        'NATIVE_PUBLICATION_NOT_FOUND',
        'No native files have been published yet',
      );
    const result = file
      ? await execution.file(row, params.fileId, recheck)
      : event.resource === GRAPH
        ? await execution.graph(row, recheck)
        : event.resource === INTERACTION
          ? await execution.interaction(row, recheck)
          : await execution.publication(row, recheck);
    return response(200, result);
  };
  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,OPTIONS' });
    const collection = event?.resource === COLLECTION;
    const preparation = event?.resource === PREPARE;
    const start = event?.resource === START;
    const cancel = event?.resource === CANCEL;
    const recover = event?.resource === RECOVER;
    const userResponse = event?.resource === RESPONSE;
    const file = event?.resource === FILE;
    const mutation = preparation || start || cancel || recover || userResponse;
    if (
      ![
        COLLECTION,
        ITEM,
        PREPARE,
        START,
        CANCEL,
        RECOVER,
        PUBLICATION,
        FILE,
        GRAPH,
        INTERACTION,
        RESPONSE,
        OUTPUTS,
      ].includes(event?.resource)
    )
      return reply(response, 404, 'NOT_FOUND', 'Route not found');
    const methods = collection
      ? ['GET', 'POST', 'OPTIONS']
      : mutation
        ? ['POST', 'OPTIONS']
        : ['GET', 'OPTIONS'];
    if (!methods.includes(event.httpMethod))
      return response(
        405,
        { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' },
        { Allow: methods.join(',') },
      );
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    if (enabled !== true)
      return reply(response, 503, 'NATIVE_PREPARATION_DISABLED', 'Native preparation is disabled');
    const claims = event.requestContext?.authorizer?.claims;
    const actorId = record(claims) && Object.hasOwn(claims, 'sub') ? claims.sub : undefined;
    if (!matches(actorId, ID))
      return reply(response, 401, 'UNAUTHORIZED', 'Authentication required');
    const invalid = () =>
      reply(response, 400, 'NATIVE_PREPARATION_INVALID', 'Invalid native preparation request');
    const params = event.pathParameters;
    if (
      !record(params) ||
      !matches(params.projectId, ID) ||
      (!collection && !matches(params.intentId, UUID_V4)) ||
      (file && !matches(params.fileId, /^nf-[a-f0-9]{64}$/)) ||
      Object.keys(params).some(
        (key) =>
          !['projectId', ...(collection ? [] : ['intentId']), ...(file ? ['fileId'] : [])].includes(
            key,
          ),
      ) ||
      ['operation', 'op', 'action'].some((key) => Object.hasOwn(event, key)) ||
      (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
    )
      return invalid();
    const { projectId, intentId } = params;
    const outputRead = event.resource === OUTPUTS;
    const suffix = suffixFor(event.resource, params);
    const expectedPath = `/api/projects/${projectId}/native-intents${collection ? '' : `/${intentId}`}${suffix}`;
    if (event.path !== undefined && event.path !== expectedPath) return invalid();
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
    let input;
    try {
      const after = outputRead ? outputCursor(event) : 0;
      const listing = outputRead ? null : nativeListQuery(event, { collection, projectId });
      if (collection && event.httpMethod === 'POST') {
        if (typeof event.body !== 'string') return invalid();
        if (Buffer.byteLength(event.body) > 96 * 1024)
          return response(413, {
            code: 'NATIVE_PREPARATION_BODY_TOO_LARGE',
            error: 'Native draft request is too large',
            draftInputRejected: true,
          });
        try {
          input = nativeDraftRequest(JSON.parse(event.body));
        } catch {
          // This attempt has not reached any dependencies or persistence. The
          // generic INVALID code can also originate from a committed-row read;
          // only this boundary identifies editable draft input. It says nothing
          // about earlier attempts using the same identity.
          return response(400, {
            code: 'NATIVE_PREPARATION_INVALID',
            error: 'Invalid native preparation request',
            draftInputRejected: true,
          });
        }
      } else if (event.body !== undefined && event.body !== null && event.body !== '') {
        // JSON escaping can expand a valid 16 KiB reply sixfold. The decoded
        // text has its own byte limit; this bounds work before JSON parsing.
        const maxBody = userResponse ? 100 * 1024 : 1024;
        if (!mutation || typeof event.body !== 'string' || Buffer.byteLength(event.body) > maxBody)
          return invalid();
        try {
          const body = JSON.parse(event.body);
          if (start) {
            if (
              !record(body) ||
              Object.keys(body).length !== 1 ||
              !matches(body.requestId, UUID_V4)
            )
              return invalid();
            input = body;
          } else if (userResponse) {
            if (!validReply(body)) return invalid();
            input = body;
          } else if (recover) {
            if (
              !record(body) ||
              Object.keys(body).length !== 2 ||
              !matches(body.requestId, UUID_V4) ||
              !matches(body.recoveryId, UUID_V4)
            )
              return invalid();
            input = body;
          } else if (!record(body) || Object.keys(body).length) return invalid();
        } catch {
          return invalid();
        }
      }
      if ((start || userResponse || recover) && !input) return invalid();
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
      if (collection && event.httpMethod === 'GET')
        return await collectionRead({ listing, projectId, before, recheck, response });
      const authorizeSource = (request) =>
        workflowSources.getAuthorizedBinding({
          projectId,
          actorId,
          sourceId: request.sourceId,
          expectedRevision: request.bindingRevision,
        });
      const readPins = async (request) => {
        const binding = await authorizeSource(request);
        const job = await jobs.get({ projectId, jobId: request.packageJobId });
        const pins = pinPackageJob(job, { projectId, request, binding });
        // No credential reads: recheck the current protected source revision
        // after the package lookup and before persisting or enqueueing work.
        await authorizeSource(request);
        await recheck();
        return pins;
      };
      if (collection) {
        if (!admissionEnabled && !(await store.get({ projectId, executionId: input.intentId })))
          return reply(
            response,
            503,
            'NATIVE_PREPARATION_DISABLED',
            'New native drafts are disabled',
          );
        const pins = await readPins(input);
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
      }
      const identity = { projectId, executionId: intentId };
      let row = await store.get(identity);
      if (!row) fail('NOT_FOUND');
      await recheck(row);
      if (outputRead) {
        if (!execution?.outputs) return response(200, { outputs: [], nextAfter: null });
        return response(200, await execution.outputs(row, after, recheck));
      }
      if (start || cancel || userResponse || recover)
        return await executionCommand({
          start,
          userResponse,
          recover,
          row,
          actorId,
          input,
          recheck,
          before,
          response,
        });
      if ([PUBLICATION, FILE, GRAPH, INTERACTION].includes(event.resource))
        return await committedRead({ event, file, row, params, recheck, response });
      if (!preparation)
        return response(200, {
          ...nativeIntentView(row),
          ...(execution ? await execution.status(row, recheck) : {}),
        });
      const pins = await readPins(row.request);
      if (
        canonicalJson(pins.candidate) !== canonicalJson(row.candidate) ||
        canonicalJson(pins.archiveReceipt) !== canonicalJson(row.archiveReceipt)
      )
        fail('CONFLICT');
      row = await store.prepare(identity);
      await authorizeSource(row.request);
      await recheck(row);
      if (row.status === 'PREPARING') {
        // Commit first. A lost SQS acknowledgement leaves PREPARING intact;
        // retrying prepare sends the same pointer without minting a new run.
        try {
          await enqueue(identity);
        } catch {
          // Committed PREPARING state is delivered by the stream bridge.
        }
      }
      return response(row.status === 'PREPARING' ? 202 : 200, {
        ...nativeIntentView(row),
        ...(execution ? await execution.status(row, recheck) : {}),
      });
    } catch (error) {
      const code =
        error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
      if (typeof code === 'string' && Object.hasOwn(ERRORS, code)) {
        const [status, message] = ERRORS[code];
        return reply(response, status, code, message);
      }
      return nativePreparationInternalError(event);
    }
  };
};
