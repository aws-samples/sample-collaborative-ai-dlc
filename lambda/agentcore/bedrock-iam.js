import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fromHttp } from '@aws-sdk/credential-providers';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { listClaudeModels } from '../shared/bedrock-models.js';
import { runtimeAwsSnapshot } from './runtime-aws-auth.js';
import { credentialFailureError } from './invocation-credentials.js';

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

// One authenticated loopback endpoint per invocation. The renewal token and STS
// values stay in memory. CLIs receive only the local URI and a random access
// token, and use their native container credential provider to renew.
export const prepareBedrockIamEnv = async (credential, { renew, now = () => Date.now() } = {}) => {
  let cached = validCredentials(credential.iamCredentials, now);
  const expiresAt = credential.renewalExpiresAt;
  if (!credential.renewalToken || !Number.isFinite(expiresAt) || expiresAt <= now() || !renew) {
    throw new Error('The broker did not authorize IAM credential renewal');
  }
  const authorization = randomBytes(32).toString('hex');
  let inFlight = null;
  let closed = false;
  let references = 1;
  let refreshTimer;
  let expiryTimer;
  const controller = new AbortController();
  const fail = (code) => {
    if (closed || controller.signal.aborted) return;
    clearTimeout(refreshTimer);
    clearTimeout(expiryTimer);
    controller.abort(credentialFailureError(code));
  };
  const watchExpiration = () => {
    clearTimeout(expiryTimer);
    if (closed || controller.signal.aborted) return;
    const deadline = Math.min(expiresAt, Date.parse(cached.Expiration));
    expiryTimer = setTimeout(
      () => {
        if (now() >= expiresAt) fail('bedrock_authorization_expired');
        else if (now() >= Date.parse(cached.Expiration)) fail('bedrock_credentials_expired');
        else watchExpiration();
      },
      Math.max(1, deadline - now()),
    );
    expiryTimer.unref();
  };
  const scheduleRefresh = (delay) => {
    clearTimeout(refreshTimer);
    if (closed || controller.signal.aborted) return;
    refreshTimer = setTimeout(
      () => {
        refresh().catch(() => scheduleRefresh(30_000));
      },
      delay ?? Math.max(1000, Date.parse(cached.Expiration) - now() - 5 * 60_000),
    );
    refreshTimer.unref();
  };
  const refresh = () => {
    if (closed || controller.signal.aborted || now() >= expiresAt)
      return Promise.reject(new Error('IAM invocation authorization expired'));
    inFlight ??= Promise.resolve()
      .then(renew)
      .then((value) => {
        if (closed || controller.signal.aborted) throw new Error('IAM invocation has ended');
        cached = validCredentials(value, now);
        watchExpiration();
        scheduleRefresh();
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const getCredentials = async () => {
    if (closed || controller.signal.aborted || now() >= expiresAt)
      throw new Error('IAM invocation authorization expired');
    const remaining = Date.parse(cached.Expiration) - now();
    if (remaining > 5 * 60_000) return cached;
    if (remaining > 60_000) {
      // Serve still-valid credentials while STS renews, so CLI metadata timeouts
      // do not depend on a broker cold start.
      refresh().catch(() => {});
      return cached;
    }
    return refresh();
  };
  const server = createServer(async (request, response) => {
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
    try {
      const value = await getCredentials();
      response.end(JSON.stringify(value));
    } catch {
      response.writeHead(503);
      response.end('{"error":"Inference credentials unavailable"}');
    }
  });
  server.requestTimeout = 30_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  const close = () => {
    if (closed) return;
    closed = true;
    cached = null;
    clearTimeout(timer);
    clearTimeout(refreshTimer);
    clearTimeout(expiryTimer);
    server.closeAllConnections();
    server.close();
  };
  const timer = setTimeout(() => {
    fail('bedrock_authorization_expired');
    close();
  }, expiresAt - now());
  timer.unref();
  watchExpiration();
  scheduleRefresh();
  return {
    credentialSignal: controller.signal,
    env: {
      BEDROCK_IAM_CREDENTIALS_URI: `http://127.0.0.1:${server.address().port}/credentials`,
      BEDROCK_IAM_AUTHORIZATION_TOKEN: authorization,
      BEDROCK_REGION: credential.binding.iam.region,
    },
    retain: () => {
      if (!closed) references += 1;
    },
    dispose: () => {
      if (--references <= 0) close();
    },
  };
};

export const bedrockDriverAuthEnv = (env) =>
  env.BEDROCK_IAM_CREDENTIALS_URI
    ? {
        AIDLC_RUNTIME_AWS_ENV: runtimeAwsSnapshot(env),
        AWS_CONTAINER_CREDENTIALS_FULL_URI: env.BEDROCK_IAM_CREDENTIALS_URI,
        AWS_CONTAINER_AUTHORIZATION_TOKEN: env.BEDROCK_IAM_AUTHORIZATION_TOKEN,
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
        AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: undefined,
        AWS_PROFILE: undefined,
        AWS_DEFAULT_PROFILE: undefined,
        AWS_CONFIG_FILE: '/dev/null',
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_SESSION_TOKEN: undefined,
        AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
        AWS_ROLE_ARN: undefined,
        AWS_EC2_METADATA_DISABLED: 'true',
        AWS_BEARER_TOKEN_BEDROCK: undefined,
      }
    : env.AWS_BEARER_TOKEN_BEDROCK
      ? { AWS_BEARER_TOKEN_BEDROCK: env.AWS_BEARER_TOKEN_BEDROCK }
      : {};

export const listIamBedrockModels = async (
  env,
  { createClient = (config) => new BedrockClient(config) } = {},
) => {
  const client = createClient({
    region: env.BEDROCK_REGION,
    credentials: fromHttp({
      awsContainerCredentialsFullUri: env.BEDROCK_IAM_CREDENTIALS_URI,
      awsContainerAuthorizationToken: env.BEDROCK_IAM_AUTHORIZATION_TOKEN,
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
