// Dedicated REST API Gateway boundary. Cognito claims here are trusted only
// because the gateway authorizer and this Lambda's invocation IAM are trusted;
// this function does not independently verify a JWT or accept internal ops.
import { buildResponse } from '../shared/response.js';
import { WorkflowSourceError, workflowSourceIdentity } from '../shared/workflow-source-bindings.js';
import { NativePackageJobError } from '../shared/native-package-jobs.js';

const COLLECTION = '/api/projects/{projectId}/workflow-sources';
const ITEM = `${COLLECTION}/{sourceId}`;
const PACKAGES = `${ITEM}/packages`;
const PACKAGE_JOB = `${PACKAGES}/{jobId}`;
const BODY_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const SOURCE_ID = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RELEASE =
  /^(?:latest|v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?)$/;
const JOB_KEYS = new Set(['jobId', 'expectedRevision', 'requestedRelease']);
const JOB_ERRORS = Object.freeze({
  native_package_job_invalid: [400, 'Invalid package import request'],
  native_package_job_conflict: [409, 'This job ID already belongs to a different import request'],
  native_package_job_not_found: [404, 'Package import not found'],
  native_package_job_unavailable: [503, 'Package import service unavailable'],
});
const POST_KEYS = new Set([
  'provider',
  'repository',
  'authType',
  'confirmDelegation',
  'expectedRevision',
]);
const ERRORS = Object.freeze({
  WORKFLOW_SOURCE_INVALID: [400, 'Invalid workflow source request'],
  WORKFLOW_SOURCE_FORBIDDEN: [403, 'Workflow source access denied'],
  WORKFLOW_SOURCE_CONFLICT: [409, 'Workflow source changed; reload before retrying'],
  WORKFLOW_SOURCE_NOT_FOUND: [404, 'Workflow source not found'],
  WORKFLOW_SOURCE_UNAVAILABLE: [503, 'Workflow source service unavailable'],
});
// Exact codes emitted by source-control-credentials and its git-token/store
// dependencies. Their Error messages, causes, scopes, and provider statuses can
// contain private data; only these fixed code/message pairs may reach HTTP.
const CREDENTIAL_ERRORS = Object.freeze({
  CONNECTION_REQUIRED: [
    400,
    'Connect or reconnect your Git provider account before configuring this source',
  ],
  CONNECTION_CHANGED: [
    400,
    'Your Git provider connection changed. Reload your connections and retry',
  ],
  DELEGATION_CONFIRMATION_REQUIRED: [
    400,
    'Confirm delegation of your connected account to this workflow source',
  ],
  BINDING_INVALID: [
    400,
    'The workflow source credential configuration is invalid. Reload and configure the source again',
  ],
  MISSING_SCOPES: [
    403,
    'Reconnect your Git provider account with the required repository permissions',
  ],
  INSUFFICIENT_REPOSITORY_ACCESS: [
    403,
    'Repository read access could not be verified. Check the repository and selected authentication method',
  ],
  APP_INSTALLATION_UNAVAILABLE: [
    403,
    'Install or re-enable the GitHub App for this repository, then retry',
  ],
  APP_CONFIG_INCOMPLETE: [
    503,
    'A platform administrator must configure the GitHub App before it can be used',
  ],
  APP_CREDENTIAL_FAILED: [
    503,
    'GitHub App authentication failed. Ask a platform administrator to check its configuration',
  ],
  CREDENTIAL_REFRESH_FAILED: [
    503,
    'The provider connection could not be refreshed. Retry, or reconnect your account',
  ],
});
const record = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const errorBody = (code, error) => ({ code, error });
const invalid = (response) =>
  response(400, errorBody('WORKFLOW_SOURCE_INVALID', 'Invalid workflow source request'));
export const workflowSourceInternalError = (event) =>
  buildResponse(event, {
    methods: 'GET,POST,DELETE,OPTIONS',
  })(500, errorBody('WORKFLOW_SOURCE_INTERNAL_ERROR', 'Workflow source request failed'));

const parseBody = (event, response) => {
  if (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false) {
    return { error: invalid(response) };
  }
  if (typeof event.body !== 'string') return { error: invalid(response) };
  if (event.body.length > BODY_BYTES || Buffer.byteLength(event.body, 'utf8') > BODY_BYTES) {
    return {
      error: response(
        413,
        errorBody('WORKFLOW_SOURCE_BODY_TOO_LARGE', 'Workflow source request body is too large'),
      ),
    };
  }
  try {
    const value = JSON.parse(event.body);
    return record(value) ? { value } : { error: invalid(response) };
  } catch {
    return { error: invalid(response) };
  }
};

export const createWorkflowSourcesHandler = ({
  service,
  packageJobs,
  enabled = false,
  packageJobsEnabled = false,
} = {}) => {
  if (
    !service ||
    ['list', 'configure', 'remove'].some((name) => typeof service[name] !== 'function')
  ) {
    throw new TypeError('A workflow source service is required');
  }
  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,DELETE,OPTIONS' });
    const collection = event?.resource === COLLECTION;
    const packages = event?.resource === PACKAGES;
    const packageJob = event?.resource === PACKAGE_JOB;
    const jobRoute = packages || packageJob;
    if (!collection && event?.resource !== ITEM && !jobRoute) {
      return response(404, errorBody('NOT_FOUND', 'Route not found'));
    }
    const methods = collection
      ? ['GET', 'POST', 'OPTIONS']
      : packages
        ? ['POST', 'OPTIONS']
        : packageJob
          ? ['GET', 'OPTIONS']
          : ['DELETE', 'OPTIONS'];
    if (!methods.includes(event.httpMethod)) {
      return response(405, errorBody('METHOD_NOT_ALLOWED', 'Method not allowed'), {
        Allow: methods.join(','),
      });
    }
    if (event.httpMethod === 'OPTIONS') return response(200, {});
    if (enabled !== true) {
      return response(
        503,
        errorBody('WORKFLOW_SOURCE_API_DISABLED', 'Workflow source API is disabled'),
      );
    }
    if (jobRoute && packageJobsEnabled !== true) {
      return response(
        503,
        errorBody('NATIVE_PACKAGE_JOBS_DISABLED', 'Package imports are disabled'),
      );
    }
    const claims = event.requestContext?.authorizer?.claims;
    const actorId = record(claims) && Object.hasOwn(claims, 'sub') ? claims.sub : undefined;
    if (!matches(actorId, ID)) {
      return response(401, errorBody('UNAUTHORIZED', 'Authentication required'));
    }
    if (
      ['operation', 'op', 'action'].some((key) => Object.hasOwn(event, key)) ||
      (event.queryStringParameters && Object.keys(event.queryStringParameters).length > 0) ||
      (event.multiValueQueryStringParameters &&
        Object.keys(event.multiValueQueryStringParameters).length > 0)
    )
      return invalid(response);

    const parameters = event.pathParameters;
    if (
      !record(parameters) ||
      !matches(parameters.projectId, ID) ||
      Object.keys(parameters).some(
        (key) =>
          ![
            'projectId',
            ...(collection ? [] : ['sourceId']),
            ...(packageJob ? ['jobId'] : []),
          ].includes(key),
      ) ||
      (!collection && !matches(parameters.sourceId, SOURCE_ID)) ||
      (packageJob && !matches(parameters.jobId, REVISION))
    )
      return invalid(response);
    const { projectId, sourceId, jobId } = parameters;
    const expectedPath = `/api/projects/${projectId}/workflow-sources${collection ? '' : `/${sourceId}`}${jobRoute ? '/packages' : ''}${packageJob ? `/${jobId}` : ''}`;
    if (event.path !== undefined && event.path !== expectedPath) return invalid(response);

    try {
      if (event.httpMethod === 'GET') {
        if (
          (event.body !== undefined && event.body !== null && event.body !== '') ||
          (event.isBase64Encoded !== undefined && event.isBase64Encoded !== false)
        ) {
          return invalid(response);
        }
        return response(
          200,
          packageJob
            ? await packageJobs.get({ projectId, actorId, sourceId, jobId })
            : {
                sources: await service.list({ projectId, actorId }),
                // Use the same effective gate as the package routes, independently
                // of source administration and without exposing host configuration.
                capabilities: { packageImportsEnabled: packageJobsEnabled === true },
              },
        );
      }
      const parsed = parseBody(event, response);
      if (parsed.error) return parsed.error;
      const body = parsed.value;
      if (packages) {
        if (
          Object.keys(body).some((key) => !JOB_KEYS.has(key)) ||
          !matches(body.jobId, REVISION) ||
          !matches(body.expectedRevision, REVISION) ||
          (Object.hasOwn(body, 'requestedRelease') &&
            (typeof body.requestedRelease !== 'string' ||
              body.requestedRelease.length > 256 ||
              !matches(body.requestedRelease, RELEASE)))
        )
          return invalid(response);
        return response(
          202,
          await packageJobs.create({
            projectId,
            actorId,
            sourceId,
            jobId: body.jobId,
            expectedRevision: body.expectedRevision,
            requestedRelease: body.requestedRelease ?? 'latest',
          }),
        );
      }
      if (event.httpMethod === 'DELETE') {
        if (Object.keys(body).length !== 1 || !matches(body.expectedRevision, REVISION))
          return invalid(response);
        await service.remove({
          projectId,
          actorId,
          sourceId,
          expectedRevision: body.expectedRevision,
        });
        return { ...response(204, null), body: '' };
      }
      if (
        Object.keys(body).some((key) => !POST_KEYS.has(key)) ||
        !Object.hasOwn(body, 'expectedRevision') ||
        (body.expectedRevision !== null && !matches(body.expectedRevision, REVISION)) ||
        !['github', 'gitlab', 'bitbucket'].includes(body.provider) ||
        ![
          'public',
          `${body.provider}-oauth`,
          ...(body.provider === 'github' ? ['github-app'] : []),
        ].includes(body.authType) ||
        (Object.hasOwn(body, 'confirmDelegation') && typeof body.confirmDelegation !== 'boolean') ||
        (body.authType.endsWith('-oauth') && body.confirmDelegation !== true)
      )
        return invalid(response);
      // Validate repository syntax using the service's identity contract.
      // The service still owns normalization, authorization, and conditional writes.
      workflowSourceIdentity(body.provider, body.repository);
      const selection = {
        provider: body.provider,
        repository: body.repository,
        authType: body.authType,
        ...(Object.hasOwn(body, 'confirmDelegation')
          ? { confirmDelegation: body.confirmDelegation }
          : {}),
      };
      const source = await service.configure({
        projectId,
        actorId,
        selection,
        expectedRevision: body.expectedRevision,
      });
      return response(200, source);
    } catch (error) {
      if (error instanceof Error) {
        // Helpers attach an own data property. Do not invoke a getter or coerce
        // an arbitrary code object while handling an already-failed request.
        const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
        const workflow =
          error instanceof WorkflowSourceError &&
          Object.entries(ERRORS).find(([known]) => known === code);
        const credential = Object.entries(CREDENTIAL_ERRORS).find(([known]) => known === code);
        const job =
          error instanceof NativePackageJobError &&
          Object.entries(JOB_ERRORS).find(([known]) => known === code);
        const mapped = workflow || credential || job;
        if (mapped) {
          const [known, [status, message]] = mapped;
          return response(status, errorBody(known, message));
        }
      }
      return workflowSourceInternalError(event);
    }
  };
};
