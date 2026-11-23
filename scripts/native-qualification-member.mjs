// The public Lambda forwards the original bearer to its commands alias. Only
// the Lambda transport, token verifier and membership lookup are local ports.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { handler } from '../lambda/native-runtime-control/index.js';
import { createNativeAuthority } from '../lambda/native-runtime-control/authority.js';
import { createNativeRuntimeApi } from '../lambda/native-runtime-control/api.js';
import { ACTOR, MEMBERSHIP } from '../lambda/native-runtime-control/test/fixtures.js';

export function qualificationMember(f, execution) {
  const functionName = `arn:aws:lambda:us-east-1:${f.configuration.accountId}:function:fixture-authority`;
  const member = 'offline-member-bearer';
  const authority = createNativeAuthority({
    functionName,
    verify: async (token) => {
      if (token === member) return { sub: ACTOR };
      if (token === 'offline-nonmember') return { sub: 'fixture-nonmember' };
      throw Object.assign(new Error('Invalid fixture token'), {
        code: 'NATIVE_AUTHORITY_FORBIDDEN',
      });
    },
    commands: createNativeRuntimeApi({
      enabled: true,
      store: f.preparationStore,
      execution,
      getMembershipSnapshot: async (project, actor) =>
        project === f.identity.projectId && actor === ACTOR ? MEMBERSHIP : null,
    }),
  });
  const previous = process.env.NATIVE_AUTHORITY_FUNCTION;
  process.env.NATIVE_AUTHORITY_FUNCTION = functionName;
  const entry = realpathSync(new URL('../lambda/native-runtime-control/index.js', import.meta.url));
  const { LambdaClient } = createRequire(entry)('@aws-sdk/client-lambda');
  const port = mock.method(LambdaClient.prototype, 'send', async ({ input }) => {
    assert.equal(input.FunctionName, `${functionName}:commands`);
    const result = await authority(JSON.parse(input.Payload), {
      invokedFunctionArn: input.FunctionName,
    });
    return { Payload: Buffer.from(JSON.stringify(result)) };
  });
  return {
    async request(route, body, { status = body ? 202 : 200, query, token = member } = {}) {
      const resource = `/api/projects/{projectId}/native-intents/{intentId}${route ? `/${route}` : ''}`;
      const { projectId, executionId: intentId } = f.identity;
      const response = await handler({
        resource,
        path: resource.replace('{projectId}', projectId).replace('{intentId}', intentId),
        pathParameters: { projectId, intentId },
        httpMethod: body ? 'POST' : 'GET',
        requestContext: { authorizer: { claims: { sub: 'untrusted-forwarded-actor' } } },
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        queryStringParameters: query,
        body: body && JSON.stringify(body),
      });
      const value = JSON.parse(response.body);
      assert.equal(response.statusCode, status, `${route}: ${value.code ?? response.statusCode}`);
      return value;
    },
    close() {
      port.mock.restore();
      if (previous === undefined) delete process.env.NATIVE_AUTHORITY_FUNCTION;
      else process.env.NATIVE_AUTHORITY_FUNCTION = previous;
    },
  };
}
