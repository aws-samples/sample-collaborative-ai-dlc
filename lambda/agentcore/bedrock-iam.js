import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fromHttp } from '@aws-sdk/credential-providers';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { listClaudeModels } from '../shared/bedrock-models.js';
import { createCredentialSession, currentCredentialSession } from './credential-session.js';

const validCredentials = (value, now) => {
  if (
    !value?.AccessKeyId ||
    !value.SecretAccessKey ||
    !value.Token ||
    !Number.isFinite(Date.parse(value.Expiration)) ||
    Date.parse(value.Expiration) <= now()
  ) {
    throw new Error('The broker returned invalid or expired inference credentials');
  }
  // Do not forward any other broker fields (in particular the renewal token).
  return {
    AccessKeyId: value.AccessKeyId,
    SecretAccessKey: value.SecretAccessKey,
    Token: value.Token,
    Expiration: value.Expiration,
  };
};

// The generic invocation session owns renewal, its fixed authorization ceiling,
// cancellation and cleanup. This adapter only supplies STS and HTTP mechanics.
export const prepareBedrockIamSession = async (
  credential,
  { env = {}, renew, now = Date.now, setTimer, clearTimer } = {},
) => {
  let cached = validCredentials(credential.iamCredentials, now);
  const authorizationExpiresAt = credential.renewalExpiresAt;
  if (!Number.isFinite(authorizationExpiresAt) || authorizationExpiresAt <= now())
    throw new Error('The broker did not authorize this IAM invocation');
  const authorization = randomBytes(32).toString('hex');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const session = createCredentialSession({
    env: {
      ...env,
      BEDROCK_AUTH_MODE: 'iam',
      BEDROCK_REGION: credential.binding.configuration.region,
    },
    credentialEnvironment: {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${server.address().port}/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: authorization,
    },
    expiresAt: Date.parse(cached.Expiration),
    authorizationExpiresAt,
    refreshBeforeMs: 5 * 60_000,
    now,
    setTimer,
    clearTimer,
    expirationCode: 'bedrock_credentials_expired',
    authorizationExpirationCode: 'bedrock_authorization_expired',
    retryRefresh: (error) =>
      ![
        'AGENT_CREDENTIAL_GRANT_INVALID',
        'AGENT_CREDENTIAL_GRANT_EXPIRED',
        'AGENT_AUTH_CONNECTION_UNAVAILABLE',
        'BEDROCK_IAM_ACCESS_DENIED',
        'credential_grant_mismatch',
      ].includes(error?.code),
    refresh:
      credential.renewalToken && renew
        ? async () => {
            const next = validCredentials(await renew(), now);
            // Keep the current credential until the whole refresh response is validated.
            if (Date.parse(next.Expiration) <= now() + 5 * 60_000)
              throw new Error('STS returned credentials too close to expiry');
            cached = next;
            return { expiresAt: Date.parse(next.Expiration) };
          }
        : null,
  });
  const getCredentials = async () => {
    session.assertAvailable();
    const remaining = Date.parse(cached.Expiration) - now();
    if (credential.renewalToken && remaining <= 5 * 60_000) {
      if (remaining > 60_000) void session.renew().catch(() => {});
      else await session.renew();
    }
    session.assertAvailable();
    return cached;
  };
  server.on('request', async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    const supplied = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(authorization);
    if (
      request.method !== 'GET' ||
      request.url !== '/credentials' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      response.writeHead(403);
      response.end('{"error":"Forbidden"}');
      return;
    }
    const unavailable = () => {
      if (!response.writableEnded) {
        response.writeHead(503);
        response.end('{"error":"Inference credentials unavailable"}');
      }
    };
    session.signal.addEventListener('abort', unavailable, { once: true });
    try {
      const value = await getCredentials();
      if (!response.writableEnded) response.end(JSON.stringify(value));
    } catch {
      unavailable();
    } finally {
      session.signal.removeEventListener('abort', unavailable);
    }
  });
  server.requestTimeout = 30_000;
  session.own(() => {
    cached = null;
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return session;
};

export const listIamBedrockModels = async (
  env,
  { createClient = (config) => new BedrockClient(config) } = {},
) => {
  const credentialEnvironment = currentCredentialSession()?.credentialEnvironment;
  if (!credentialEnvironment?.AWS_CONTAINER_CREDENTIALS_FULL_URI)
    throw new Error('IAM session is required');
  const client = createClient({
    region: env.BEDROCK_REGION,
    credentials: fromHttp({
      awsContainerCredentialsFullUri: credentialEnvironment.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      awsContainerAuthorizationToken: credentialEnvironment.AWS_CONTAINER_AUTHORIZATION_TOKEN,
      awsContainerCredentialsRelativeUri: '',
      awsContainerAuthorizationTokenFile: '',
    }),
  });
  const summaries = [];
  try {
    let nextToken;
    do {
      const result = await client.send(
        new ListInferenceProfilesCommand({
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        }),
      );
      summaries.push(...(result.inferenceProfileSummaries ?? []));
      nextToken = result.nextToken;
    } while (nextToken);
    return await listClaudeModels({
      region: env.BEDROCK_REGION,
      listInferenceProfiles: async () => summaries,
    });
  } finally {
    client.destroy?.();
  }
};
