// The public Lambda forwards the original bearer to its commands alias. Only
// the Lambda transport, token verifier and membership lookup are local ports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import { handler } from '../lambda/native-runtime-control/index.js';
import { createNativeAuthority } from '../lambda/native-runtime-control/authority.js';
import { createNativeRuntimeApi } from '../lambda/native-runtime-control/api.js';
import { ACTOR, MEMBERSHIP, pauseOnce } from '../lambda/native-runtime-control/test/fixtures.js';

export const initiator = { actorId: ACTOR, token: 'offline-member-bearer' };
export const respondent = { actorId: 'member-two', token: 'offline-respondent-bearer' };

export function qualificationMembership(projectId) {
  const members = new Map([
    [initiator.actorId, MEMBERSHIP],
    [respondent.actorId, { ...MEMBERSHIP, membershipId: 'edge-two' }],
  ]);
  return {
    lookup: (project, actor) => (project === projectId ? members.get(actor) : null),
    revoke: (actor) => assert.ok(members.delete(actor)),
  };
}

export function qualificationMember(f, execution, membership) {
  const functionName = `arn:aws:lambda:us-east-1:${f.configuration.accountId}:function:fixture-authority`;
  const authority = createNativeAuthority({
    functionName,
    verify: async (token) => {
      const identity = [initiator, respondent].find((account) => account.token === token);
      if (identity) return { sub: identity.actorId };
      if (token === 'offline-nonmember') return { sub: 'fixture-nonmember' };
      throw Object.assign(new Error('Invalid fixture token'), {
        code: 'NATIVE_AUTHORITY_FORBIDDEN',
      });
    },
    commands: createNativeRuntimeApi({
      enabled: true,
      store: f.preparationStore,
      execution,
      getMembershipSnapshot: membership.lookup,
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
    async request(route, body, { status = body ? 202 : 200, query, token = initiator.token } = {}) {
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

// Let both independently authenticated, digest-bound choices reach the store.
// Only the order at the AWS port is controlled. The real transaction must
// reject the stale write and the store must return the original winner on retry.
export async function competeForQuestion(f, member, question, winningRequest) {
  const query = {
    publicationId: question.publicationId,
    publicationSequence: String(question.sequence),
  };
  const { response, ...original } = question;
  assert.equal(response, null);
  const open = ({ token }) => member.request('interaction', undefined, { query, token });
  const [starterView, respondentView] = await Promise.all([open(initiator), open(respondent)]);
  assert.deepEqual(starterView, { interaction: original, answer: null });
  assert.deepEqual(respondentView, starterView);
  assert.equal(winningRequest.interactionId, respondentView.interaction.id);
  assert.equal(winningRequest.contentSha256, respondentView.interaction.contentSha256);
  const options = starterView.interaction.pendingInput.questions[0].options;
  const alternative = options.length - 1;
  const losingRequest = {
    requestId: randomUUID(),
    interactionId: starterView.interaction.id,
    contentSha256: starterView.interaction.contentSha256,
    selection: { answers: [{ selectedOptions: [alternative] }] },
    text: options[alternative].label,
  };
  assert.notEqual(losingRequest.text, winningRequest.text);
  const pause = pauseOnce(f, 'before', ({ input }) =>
    input.TransactItems?.some(
      ({ Put }) =>
        Put?.Item?.sk === `RESPONSE#${original.id}` &&
        Put.Item.requestId === losingRequest.requestId &&
        Put.Item.actorId === initiator.actorId,
    ),
  );
  const losing = member.request('response', losingRequest, { token: initiator.token, status: 409 });
  let reply, conflict;
  try {
    await Promise.race([
      pause.started,
      losing.then(() => assert.fail('Competing choice must reach its guarded transaction')),
    ]);
    reply = await member.request('response', winningRequest, { token: respondent.token });
  } finally {
    pause.resume();
    delete f.hooks.before;
    conflict = (await losing).code;
  }
  assert.equal(conflict, 'NATIVE_EXECUTION_CONFLICT');
  assert.equal(reply.response.actorId, respondent.actorId);
  const ledger = await f.store.response(f.row(), original.id);
  assert.equal(ledger.commandId, reply.response.id);
  assert.equal(ledger.actorId, respondent.actorId);
  assert.equal(ledger.requestId, winningRequest.requestId);
  assert.equal(ledger.publicationId, query.publicationId);
  assert.deepEqual(ledger.selection, winningRequest.selection);
  const retry = await member.request('response', winningRequest, { token: respondent.token });
  assert.deepEqual(retry.response, reply.response);
  assert.equal(retry.execution.turnSequence, question.sequence + 1);
  return {
    winner: ledger.actorId,
    requestId: ledger.requestId,
    commandId: ledger.commandId,
    membershipId: ledger.member.membershipId,
    selection: ledger.selection,
    textSha256: ledger.textSha256,
    retryCommandId: retry.response.id,
    loser: initiator.actorId,
    losingRequestId: losingRequest.requestId,
    losingChoice: losingRequest.text,
    conflict,
  };
}
