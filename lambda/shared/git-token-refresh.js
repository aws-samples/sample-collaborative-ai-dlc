'use strict';

const { InvokeCommand } = require('@aws-sdk/client-lambda');

/**
 * Refresh a git provider access token via the agents Lambda /git/refresh-token endpoint.
 * Currently only GitLab tokens expire (~2 h) and need refreshing; GitHub OAuth-App
 * tokens are long-lived so this is a no-op for GitHub.
 *
 * @param {import('@aws-sdk/client-lambda').LambdaClient} lambdaClient
 * @param {{ userId: string, gitProvider: string }} params
 * @returns {Promise<string|null>} New access token, or null if skipped/failed.
 */
async function refreshGitToken(lambdaClient, { userId, gitProvider }) {
  if ((gitProvider || 'github') !== 'gitlab') return null;
  if (!userId || !process.env.AGENTS_LAMBDA_NAME) return null;

  try {
    const inv = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.AGENTS_LAMBDA_NAME,
        Payload: Buffer.from(
          JSON.stringify({
            httpMethod: 'POST',
            path: '/git/refresh-token',
            body: JSON.stringify({ userId, gitProvider }),
            requestContext: { authorizer: { claims: { sub: 'system' } } },
          }),
        ),
      }),
    );
    const resp = JSON.parse(Buffer.from(inv.Payload).toString());
    const parsed = resp.body ? JSON.parse(resp.body) : {};
    if (resp.statusCode === 200 && parsed.accessToken) {
      return parsed.accessToken;
    }
    console.error(
      `[git-token-refresh] ${gitProvider} token refresh returned status ${resp.statusCode}; using existing token`,
    );
    return null;
  } catch (e) {
    console.error(
      `[git-token-refresh] ${gitProvider} token refresh failed (${e.message}); using existing token`,
    );
    return null;
  }
}

module.exports = { refreshGitToken };
