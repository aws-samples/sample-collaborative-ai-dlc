// CodeCommit platform-connection routes (issue #531). CodeCommit has no
// per-user OAuth grant: a CodeCommit repository is reached through one IAM role
// a platform admin configures once, in the account that owns the repositories,
// trusting the platform with a single per-deployment external ID. This handler
// therefore does not use shared/git-handler.js (whose surface is OAuth
// connect/callback/status/disconnect over a per-user connection row).
//
//   GET  /codecommit/admin/config   (platform admin) the execution roles the
//                                    tenant must trust, the external ID, the
//                                    exact trust and permissions policies to
//                                    paste, and the saved role ARN + region.
//   PUT  /codecommit/admin/config   (platform admin) { roleArn, region } ->
//                                    validate, prove the trust with one
//                                    AssumeRole + ListRepositories, then write.
//                                    Trust failure: 424, nothing written.
//   GET  /codecommit/status         (any user) { configured, region } — enough
//                                    for the create-space form to gate on,
//                                    without exposing principals or policies.
//   GET  /codecommit/repos          (any user) the repositories the platform
//                                    role can read in the configured region, as
//                                    a bare GitRepo[] like every other provider.
//
// Project-scoped operations (branches, tree, contents, pull requests) go
// through /projects/{id}/source-control with the binding credential like every
// other provider; nothing here handles them.
import { STSClient } from '@aws-sdk/client-sts';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Logger } from '@aws-lambda-powertools/logger';
import { buildResponse } from '../shared/response.js';
import { requirePlatformAdmin } from '../shared/authz.js';
import { redactEventForLogging } from '../shared/safe-event-logger.js';
import { getUserId } from '../shared/git-oauth.js';
import { getProvider } from '../shared/git-providers.js';
import {
  assumeCodeCommitRole,
  codeCommitTagPermissionsPolicy,
  codeCommitTrustPolicy,
  isCodeCommitRoleArn,
  roleAccountId,
} from '../shared/codecommit-role.js';
import {
  getCodeCommitConnection,
  platformExternalId,
  writeCodeCommitConnection,
} from '../shared/codecommit-platform-config.js';
import {
  isCodeCommitRegion,
  isSupportedCodeCommitRegion,
} from '../shared/git-providers/codecommit-credential.js';

const logger = new Logger({ persistentKeys: { component: 'codecommit' } });
const sts = new STSClient({});
const ssm = new SSMClient({});

// Comma-separated execution role ARNs, set by Terraform: credential broker,
// source-control API and this function. All three assume tenant roles.
const platformPrincipals = () =>
  String(process.env.CODECOMMIT_PLATFORM_PRINCIPALS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const parseBody = (body) => {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const ROLE_CODES = new Set([
  'ROLE_ASSUMPTION_DENIED',
  'ROLE_ASSUMPTION_FAILED',
  'SESSION_POLICY_INVALID',
  'BINDING_INVALID',
]);

// GetRepository probes during the list run with this much parallelism — one
// small constant, so the probe stays well under the 30 s Lambda timeout
// without opening one SDK client per repository at once.
const LIST_PROBE_CONCURRENCY = 5;

// The admin config payload. `roleArn`/`region` are null until an admin saves a
// connection. The permissions policy is the tag variant shown in the card
// (region/account filled in once a connection exists); the explicit-ARN variant
// is documented in the setup guide, not rendered here.
const adminConfig = (connection) => {
  const principals = platformPrincipals();
  const externalId = platformExternalId();
  const accountId = connection.roleArn ? roleAccountId(connection.roleArn) : undefined;
  return {
    principals,
    externalId,
    trustPolicy: codeCommitTrustPolicy({ principals, externalId }),
    permissionsPolicy: codeCommitTagPermissionsPolicy({
      ...(connection.region ? { region: connection.region } : {}),
      ...(accountId ? { accountId } : {}),
    }),
    roleArn: connection.roleArn,
    region: connection.region,
  };
};

// Run `fn` over `items` with a fixed worker count. Rejections propagate (a
// throttled probe must fail the whole request), and the first rejection leaves
// the remaining items unstarted.
const mapBounded = async (items, limit, fn) => {
  const results = Array.from({ length: items.length });
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
};

export const createCodeCommitHandler = ({
  stsClient = sts,
  ssmClient = ssm,
  provider = null,
} = {}) => {
  const codecommit = provider ?? getProvider('codecommit');

  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,PUT,OPTIONS' });
    logger.info('Request', { event: redactEventForLogging(event) });

    if (event.httpMethod === 'OPTIONS') return response(200, {});

    const { httpMethod, path } = event;
    const userId = getUserId(event);
    if (!userId) return response(401, { error: 'Unauthorized' });

    try {
      if (path.endsWith('/admin/config')) {
        const denied = requirePlatformAdmin(event);
        if (denied) return response(denied.statusCode, { error: denied.error, code: denied.code });

        if (httpMethod === 'GET') {
          const connection = await getCodeCommitConnection(ssmClient);
          return response(200, adminConfig(connection));
        }
        if (httpMethod === 'PUT') {
          const body = parseBody(event.body);
          if (!body) return response(400, { error: 'Invalid JSON body' });
          const roleArn = String(body.roleArn || '').trim();
          const region = String(body.region || '').trim();
          if (!isCodeCommitRoleArn(roleArn)) {
            return response(400, {
              error: 'A valid IAM role ARN is required',
              code: 'ROLE_ARN_INVALID',
            });
          }
          if (!isCodeCommitRegion(region)) {
            return response(400, {
              error: 'A valid AWS region is required',
              code: 'REGION_INVALID',
            });
          }
          if (!isSupportedCodeCommitRegion(region)) {
            return response(400, {
              error: `CodeCommit is not available to this deployment in ${region}`,
              code: 'REGION_UNSUPPORTED',
            });
          }
          // Prove the trust with the discover session policy and one
          // ListRepositories call before anything is written. A refused trust
          // throws a ROLE_* code, caught below as 424, and the parameter keeps
          // its previous value.
          const credentials = await assumeCodeCommitRole({
            sts: stsClient,
            roleArn,
            externalId: platformExternalId(),
            access: 'discover',
            executionId: 'admin-config',
          });
          await codecommit.listRepos({
            token: credentials,
            region,
            accountId: roleAccountId(roleArn),
          });
          await writeCodeCommitConnection(ssmClient, { roleArn, region });
          logger.info('codecommit connection updated', { by: userId, region });
          return response(200, adminConfig({ roleArn, region }));
        }
        return response(404, { error: 'Not found' });
      }

      if (httpMethod === 'GET' && path.endsWith('/status')) {
        // Any user. Only whether a connection exists and in which region — no
        // principals, external ID or policies (admin-only, issue #531).
        const connection = await getCodeCommitConnection(ssmClient);
        return response(200, {
          configured: Boolean(connection.roleArn && connection.region),
          region: connection.region,
        });
      }

      if (httpMethod === 'GET' && path.endsWith('/repos')) {
        // Any user. Lists through the platform role, like the create-space
        // repo picker of every other provider; a bare GitRepo[] is returned.
        const connection = await getCodeCommitConnection(ssmClient);
        if (!connection.roleArn || !connection.region) {
          return response(200, []);
        }
        const credentials = await assumeCodeCommitRole({
          sts: stsClient,
          roleArn: connection.roleArn,
          externalId: platformExternalId(),
          access: 'discover',
          executionId: 'discover',
        });
        const ctx = {
          token: credentials,
          region: connection.region,
          accountId: roleAccountId(connection.roleArn),
        };
        const listed = await codecommit.listRepos(ctx);
        // ListRepositories is not filtered by access, so each repository is
        // probed with GetRepository under the discover session. A repository is
        // hidden only on 403/404; a throttle or 5xx fails the whole request so
        // a throttled listing never silently shows fewer repositories.
        const readable = await mapBounded(listed, LIST_PROBE_CONCURRENCY, async (repo) => {
          try {
            await codecommit.getRepositoryAccess(ctx, repo.fullName ?? repo.arn ?? repo.id);
            return repo;
          } catch (error) {
            if (error?.status === 403 || error?.status === 404) return null;
            throw error;
          }
        });
        return response(
          200,
          readable.filter((repo) => repo !== null),
        );
      }

      return response(404, { error: 'Not found' });
    } catch (error) {
      if (ROLE_CODES.has(error?.code)) {
        logger.warn('CodeCommit role assumption failed', { code: error.code });
        // 424: the request was well-formed but depends on a tenant-side
        // resource (the trust policy) that is not in place.
        return response(424, {
          error: error.message,
          code: error.code,
          hint: 'Check that the role trusts the platform principals with this exact external ID.',
        });
      }
      if (error?.status && error.status >= 400 && error.status < 500) {
        return response(error.status, { error: error.message, code: error.code });
      }
      logger.error('Unhandled error', error);
      return response(500, { error: 'Internal server error' });
    }
  };
};

export const handler = createCodeCommitHandler();
