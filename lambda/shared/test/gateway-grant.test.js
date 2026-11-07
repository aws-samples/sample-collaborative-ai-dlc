import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import {
  DISCUSSION_GRANT_TTL_SECONDS,
  GATEWAY_GRANT_MAX_TTL_SECONDS,
  derToJose,
  gatewayPolicyDigest,
  gatewayScopeForCommand,
  issueGatewayGrant,
  kmsPublicKeyResolver,
  kmsSigner,
  verifyGatewayGrant,
} from '../gateway-grant.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'arn:aws:kms:us-east-1:111111111111:key/test';

const derSigner = (key) => async (message) => cryptoSign('sha256', message, key);
const signer = {
  sign: derSigner(privateKey),
  keyId: KID,
  now: () => NOW,
  randomId: () => 'grant-1',
};
const resolver =
  (key = publicKey) =>
  async (kid) =>
    kid === KID ? key : null;

const stageScope = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  unitSlug: null,
  sectionIndex: 0,
};

const tamper = (token, mutate) => {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return [h, Buffer.from(JSON.stringify(mutate(payload))).toString('base64url'), s].join('.');
};

describe('gateway grant', () => {
  it('round-trips a stage-scoped ES256 grant', async () => {
    const token = await issueGatewayGrant(stageScope, { ...signer, ttlSeconds: 3600 });
    const [header] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: KID,
    });
    await expect(
      verifyGatewayGrant(token, { publicKeyFor: resolver(), now: () => NOW + 60_000 }),
    ).resolves.toEqual({
      ...stageScope,
      policyDigest: null,
      stageCallbackId: null,
      orchestratorRunId: null,
      grantId: 'grant-1',
      keyId: KID,
      issuedAt: NOW / 1000,
      expiresAt: NOW / 1000 + 3600,
    });
  });

  it('carries an intent-level discussion scope without an execution', async () => {
    // Production discussions reuse the intent id as the execution id, matching
    // the local discussion MCP scope.
    const token = await issueGatewayGrant(
      { mode: 'discussion', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' },
      { ...signer, ttlSeconds: DISCUSSION_GRANT_TTL_SECONDS },
    );
    const claims = await verifyGatewayGrant(token, { publicKeyFor: resolver(), now: () => NOW });
    expect(claims).toMatchObject({ mode: 'discussion', executionId: 'i-1', stageId: null });
    expect(claims.expiresAt - claims.issuedAt).toBe(300);
  });

  it('rejects scopes that are incomplete or inconsistent with their mode', async () => {
    await expect(issueGatewayGrant({ ...stageScope, projectId: '' }, signer)).rejects.toThrow(
      'Gateway grant is invalid',
    );
    await expect(issueGatewayGrant({ ...stageScope, executionId: null }, signer)).rejects.toThrow(
      'Gateway grant is invalid',
    );
    await expect(
      issueGatewayGrant(
        { mode: 'discussion', projectId: 'p', intentId: 'i', stageId: 's' },
        signer,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      issueGatewayGrant(
        { mode: 'discussion', projectId: 'p', intentId: 'i', unitSlug: 'u' },
        signer,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      issueGatewayGrant(
        { mode: 'conflict', projectId: 'p', intentId: 'i', executionId: 'e', stageId: 's' },
        signer,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      issueGatewayGrant(
        {
          mode: 'conflict',
          projectId: 'p',
          intentId: 'i',
          executionId: 'e',
          unitSlug: 'u',
          sectionIndex: 1,
        },
        signer,
      ),
    ).resolves.toEqual(expect.any(String));
    await expect(issueGatewayGrant({ ...stageScope, mode: 'admin' }, signer)).rejects.toThrow(
      'Gateway grant is invalid',
    );
  });

  it('refuses to issue without a signer or beyond the maximum lifetime', async () => {
    await expect(issueGatewayGrant(stageScope, { keyId: KID })).rejects.toThrow(
      'Gateway grant signer is not configured',
    );
    await expect(
      issueGatewayGrant(stageScope, { ...signer, ttlSeconds: GATEWAY_GRANT_MAX_TTL_SECONDS + 1 }),
    ).rejects.toThrow('Gateway grant is invalid');
  });

  it('rejects tampered claims, foreign keys, unknown kids and widened claims', async () => {
    const token = await issueGatewayGrant(stageScope, signer);
    const opts = { publicKeyFor: resolver(), now: () => NOW };

    await expect(
      verifyGatewayGrant(
        tamper(token, (p) => ({ ...p, projectId: 'p-2' })),
        opts,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      verifyGatewayGrant(
        tamper(token, (p) => ({ ...p, admin: true })),
        opts,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      verifyGatewayGrant(token, { publicKeyFor: resolver(other.publicKey), now: () => NOW }),
    ).rejects.toThrow('Gateway grant is invalid');
    await expect(
      verifyGatewayGrant(token, { publicKeyFor: async () => null, now: () => NOW }),
    ).rejects.toThrow('Gateway grant is invalid');

    const foreign = await issueGatewayGrant(stageScope, {
      ...signer,
      sign: derSigner(other.privateKey),
    });
    await expect(verifyGatewayGrant(foreign, opts)).rejects.toThrow('Gateway grant is invalid');
  });

  it('rejects other audiences, algorithm swaps and malformed tokens', async () => {
    const token = await issueGatewayGrant(stageScope, signer);
    const [, p, s] = token.split('.');
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID })).toString(
      'base64url',
    );
    const opts = { publicKeyFor: resolver(), now: () => NOW };

    await expect(verifyGatewayGrant(`${noneHeader}.${p}.${s}`, opts)).rejects.toThrow(
      'Gateway grant is invalid',
    );
    await expect(
      verifyGatewayGrant(
        tamper(token, (c) => ({ ...c, aud: 'aidlc-agent-credential-broker' })),
        opts,
      ),
    ).rejects.toThrow('Gateway grant is invalid');
    for (const bad of ['', 'a.b', 'a.b.c.d', 'x'.repeat(5000), 42]) {
      await expect(verifyGatewayGrant(bad, opts)).rejects.toThrow('Gateway grant is invalid');
    }
  });

  it('distinguishes expiry and rejects future-dated grants', async () => {
    const token = await issueGatewayGrant(stageScope, { ...signer, ttlSeconds: 60 });
    await expect(
      verifyGatewayGrant(token, { publicKeyFor: resolver(), now: () => NOW + 61_000 }),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_EXPIRED' });
    await expect(
      verifyGatewayGrant(token, { publicKeyFor: resolver(), now: () => NOW - 3_600_000 }),
    ).rejects.toMatchObject({ code: 'GATEWAY_GRANT_INVALID' });
  });

  it('converts DER signatures to verifiable raw r||s, including zero-padded integers', () => {
    for (let i = 0; i < 200; i++) {
      const message = Buffer.from(`m${i}`);
      const jose = derToJose(cryptoSign('sha256', message, privateKey));
      expect(jose.length).toBe(64);
      expect(
        cryptoVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose),
      ).toBe(true);
    }
  });

  it('signs through KMS and resolves only allow-listed public keys', async () => {
    const commandType = () =>
      class {
        constructor(input) {
          Object.assign(this, { input });
        }

        toJSON() {
          return this.input;
        }
      };
    const SignCommand = commandType();
    const GetPublicKeyCommand = commandType();
    const calls = [];
    const kms = {
      send: async (command) => {
        calls.push(command.input);
        if (command instanceof SignCommand) {
          return { Signature: cryptoSign('sha256', command.input.Message, privateKey) };
        }
        return { PublicKey: publicKey.export({ format: 'der', type: 'spki' }) };
      },
    };
    const token = await issueGatewayGrant(stageScope, {
      ...signer,
      sign: kmsSigner({ kms, SignCommand, keyId: KID }),
    });
    const publicKeyFor = kmsPublicKeyResolver({ kms, GetPublicKeyCommand, allowedKeyIds: [KID] });

    await expect(
      verifyGatewayGrant(token, { publicKeyFor, now: () => NOW }),
    ).resolves.toMatchObject({ projectId: 'p-1' });
    await verifyGatewayGrant(token, { publicKeyFor, now: () => NOW });
    expect(
      calls.filter((c) => c.SigningAlgorithm === 'ECDSA_SHA_256' && c.MessageType === 'RAW'),
    ).toHaveLength(1);
    expect(calls.filter((c) => c.KeyId === KID && !c.Message)).toHaveLength(1);
    await expect(publicKeyFor('arn:aws:kms:us-east-1:111111111111:key/evil')).resolves.toBeNull();
  });

  it('pins the stage release policy by a key-order-independent digest', async () => {
    const policy = { learnings: 'off', summaryConfirmation: 'required' };
    const digest = gatewayPolicyDigest(policy);
    expect(digest).toBe(gatewayPolicyDigest({ summaryConfirmation: 'required', learnings: 'off' }));
    expect(gatewayPolicyDigest(null)).toBeNull();
    const scope = gatewayScopeForCommand(
      {
        command: 'run-stage-start',
        stageId: 's',
        unitSlug: 'api',
        sectionIndex: 1,
        stageCallbackId: 'cb-1',
        orchestratorRunId: 'run-1',
      },
      { projectId: 'p', intentId: 'i', executionId: 'e', policy },
    );
    expect(scope).toEqual({
      mode: 'stage',
      projectId: 'p',
      intentId: 'i',
      executionId: 'e',
      stageId: 's',
      unitSlug: 'api',
      sectionIndex: 1,
      policyDigest: digest,
      stageCallbackId: 'cb-1',
      orchestratorRunId: 'run-1',
    });
    const claims = await verifyGatewayGrant(await issueGatewayGrant(scope, signer), {
      publicKeyFor: resolver(),
      now: () => NOW,
    });
    expect(claims.policyDigest).toBe(digest);
    expect(claims).toMatchObject({ stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' });
    expect(gatewayScopeForCommand({ command: 'refresh-intent' }, scope)).toBeNull();
  });

  it('scopes a conflict resolution to its execution and lane, without a stage', () => {
    expect(
      gatewayScopeForCommand(
        { command: 'resolve-conflict', unitSlug: 'api', sectionIndex: 2, stageId: 'ignored' },
        { projectId: 'p', intentId: 'i', executionId: 'e', policy: { learnings: 'off' } },
      ),
    ).toEqual({
      mode: 'conflict',
      projectId: 'p',
      intentId: 'i',
      executionId: 'e',
      unitSlug: 'api',
      sectionIndex: 2,
    });
  });

  it('scopes engine data commands to their execution only', async () => {
    const identity = { projectId: 'p', intentId: 'i', executionId: 'e' };
    for (const command of [
      'init-ws',
      'promote-units',
      'create-workflow-checkpoint',
      'record-pr',
      'record-learning',
      'record-unit-pr',
      'derive-artifacts',
      'compose-plan-start',
      'quorum-edit-plan-start',
      'quorum-edit-apply-start',
      'repair-structure',
    ]) {
      // Lane and stage selectors in the payload never narrow or widen the grant.
      expect(
        gatewayScopeForCommand(
          { command, stageId: 's', unitSlug: 'api', sectionIndex: 1, stageCallbackId: 'cb' },
          { ...identity, policy: { learnings: 'off' } },
        ),
      ).toEqual({ mode: 'execution', ...identity });
    }
    const claims = await verifyGatewayGrant(
      await issueGatewayGrant(gatewayScopeForCommand({ command: 'init-ws' }, identity), signer),
      { publicKeyFor: resolver(), now: () => NOW },
    );
    expect(claims).toMatchObject({
      mode: 'execution',
      ...identity,
      stageId: null,
      unitSlug: null,
      sectionIndex: null,
      stageCallbackId: null,
      orchestratorRunId: null,
    });
  });

  it('rejects execution grants without an execution or with stage or lane selectors', async () => {
    const execution = { mode: 'execution', projectId: 'p', intentId: 'i', executionId: 'e' };
    for (const scope of [
      { ...execution, executionId: null },
      { ...execution, stageId: 's' },
      { ...execution, stageCallbackId: 'cb' },
      { ...execution, orchestratorRunId: 'run' },
      { ...execution, unitSlug: 'api' },
      { ...execution, sectionIndex: 0 },
    ]) {
      await expect(issueGatewayGrant(scope, signer)).rejects.toThrow('Gateway grant is invalid');
    }
    const token = await issueGatewayGrant(execution, signer);
    await expect(
      verifyGatewayGrant(
        tamper(token, (p) => ({ ...p, stageId: 's' })),
        { publicKeyFor: resolver(), now: () => NOW },
      ),
    ).rejects.toThrow('Gateway grant is invalid');
  });

  it('issues no grant for commands without one, discussions, or unknown commands', () => {
    const identity = { projectId: 'p', intentId: 'i', executionId: 'e' };
    for (const command of [
      'refresh-intent',
      'capabilities',
      'managed-runtime-check',
      'verify-mcp',
      'verify-connection',
      'discussion-assist-start',
      'nope',
      'toString',
    ]) {
      expect(gatewayScopeForCommand({ command }, identity)).toBeNull();
    }
    expect(gatewayScopeForCommand(null, identity)).toBeNull();
  });

  it('issues an execution grant for inspect and the lane commands', () => {
    const identity = { projectId: 'p', intentId: 'i', executionId: 'e' };
    for (const command of ['inspect', 'init-lane', 'merge-lane', 'reconcile-lane']) {
      expect(gatewayScopeForCommand({ command, unitSlug: 'api' }, identity)).toEqual({
        mode: 'execution',
        ...identity,
      });
    }
  });
});
