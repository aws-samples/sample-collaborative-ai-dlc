// CodeCommit connection routes — the `codecommit-role` counterpart of the
// per-provider OAuth handlers (github/gitlab/bitbucket). There is no personal
// connection: a CodeCommit repository is reached through an IAM role the
// tenant creates in the repository's account and trusts the platform with.
// This handler therefore does not use shared/git-handler.js (whose surface is
// OAuth connect/callback/status/disconnect over a per-user connection row).
//
//   GET  /codecommit/status         platform side of the handshake: the
//                                   execution roles the tenant must trust
//   GET  /codecommit/connect-info   a fresh external id + the exact trust
//                                   policy JSON to paste on the tenant role
//                                   (?externalId= re-renders for an existing one)
//   POST /codecommit/repos          { roleArn, externalId, region } -> the
//                                   repositories the role can see in that
//                                   region, listed with a discover-only
//                                   session policy (ListRepositories +
//                                   BatchGetRepositories, nothing else)
//
// Project-scoped operations (branches, tree, contents, pull requests) go
// through /projects/{id}/source-control with the binding credential like every
// other provider; nothing here handles them.
import { STSClient } from '@aws-sdk/client-sts';
import { Logger } from '@aws-lambda-powertools/logger';
import { buildResponse } from '../shared/response.js';
import { redactEventForLogging } from '../shared/safe-event-logger.js';
import { getUserId } from '../shared/git-oauth.js';
import { getProvider } from '../shared/git-providers.js';
import {
  assumeCodeCommitRole,
  codeCommitTrustPolicy,
  isCodeCommitExternalId,
  isCodeCommitRoleArn,
  newCodeCommitExternalId,
  roleAccountId,
} from '../shared/codecommit-role.js';
import { isCodeCommitRegion } from '../shared/git-providers/codecommit-credential.js';

const logger = new Logger({ persistentKeys: { component: 'codecommit' } });
const sts = new STSClient({});

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

export const createCodeCommitHandler = ({ stsClient = sts, provider = null } = {}) => {
  const codecommit = provider ?? getProvider('codecommit');

  return async (event) => {
    const response = buildResponse(event, { methods: 'GET,POST,OPTIONS' });
    logger.info('Request', { event: redactEventForLogging(event) });

    if (event.httpMethod === 'OPTIONS') return response(200, {});

    const { httpMethod, path, queryStringParameters } = event;
    if (!getUserId(event)) return response(401, { error: 'Unauthorized' });

    try {
      if (httpMethod === 'GET' && path.endsWith('/status')) {
        const principals = platformPrincipals();
        // "configured" mirrors the GitHub App status shape the UI already gates
        // on: without the platform principals the trust policy cannot be built.
        return response(200, {
          provider: 'codecommit',
          configured: principals.length > 0,
          principals,
        });
      }

      if (httpMethod === 'GET' && path.endsWith('/connect-info')) {
        const principals = platformPrincipals();
        if (principals.length === 0) {
          return response(503, {
            error: 'CodeCommit access is not configured on this deployment',
            code: 'CODECOMMIT_NOT_CONFIGURED',
          });
        }
        const requested = String(queryStringParameters?.externalId || '').trim();
        if (requested && !isCodeCommitExternalId(requested)) {
          return response(400, { error: 'Invalid external ID', code: 'EXTERNAL_ID_INVALID' });
        }
        const externalId = requested || newCodeCommitExternalId();
        return response(200, {
          externalId,
          principals,
          trustPolicy: codeCommitTrustPolicy({ principals, externalId }),
        });
      }

      if (httpMethod === 'POST' && path.endsWith('/repos')) {
        const body = parseBody(event.body);
        if (!body) return response(400, { error: 'Invalid JSON body' });
        const roleArn = String(body.roleArn || '').trim();
        const externalId = String(body.externalId || '').trim();
        const region = String(body.region || '').trim();
        if (!isCodeCommitRoleArn(roleArn)) {
          return response(400, {
            error: 'A valid IAM role ARN is required',
            code: 'ROLE_ARN_INVALID',
          });
        }
        if (!isCodeCommitExternalId(externalId)) {
          return response(400, { error: 'Invalid external ID', code: 'EXTERNAL_ID_INVALID' });
        }
        if (!isCodeCommitRegion(region)) {
          return response(400, { error: 'A valid AWS region is required', code: 'REGION_INVALID' });
        }
        const credentials = await assumeCodeCommitRole({
          sts: stsClient,
          roleArn,
          externalId,
          access: 'discover',
          executionId: 'discover',
        });
        const repos = await codecommit.listRepos({ token: credentials, region });
        return response(200, {
          accountId: roleAccountId(roleArn),
          region,
          repositories: repos,
        });
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
