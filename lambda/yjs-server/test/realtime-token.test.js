import { describe, it, expect } from 'vitest';
import * as yjsImpl from '../realtime-token.js';
import sharedImpl from '../../shared/realtime-token.js';

// -----------------------------------------------------------------------------
// 1. Doc-name inventory test.
//
// Enumerates EVERY Yjs doc-name format and app-WS documentId format in the
// codebase against the scope-extractor table. If you add a new doc-name
// prefix anywhere in the frontend, you MUST add it here AND teach both
// extractors about it — otherwise the Yjs server rejects it (deny-by-default)
// and this test is your tripwire.
//
// 2. Implementation-parity pinning.
//
// `lambda/yjs-server/realtime-token.js` is a standalone ESM copy of
// `lambda/shared/realtime-token.js` (the Yjs Docker build context cannot
// reach lambda/shared). Every vector below runs against BOTH implementations,
// and tokens signed by one must verify with the other.
// -----------------------------------------------------------------------------

const SPRINT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ARTIFACT_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const INTENT_ID = 'b1e0f2a4-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

// Inventory: every doc-name format in the codebase → expected scope.
// Sources (grep-verified):
//   presence-{sprintId}                      frontend/src/hooks/usePresence.ts
//   sq-{sprintId}-{questionId}               frontend/src/hooks/useCollaborativeStructuredAnswer.ts
//   requirement|userstory|task-{sprintId}-{artifactId}
//                                            frontend/src/hooks/useCollaborativeArtifact.ts
//   review-{sprintId}-{artifactId|"pending"} frontend/src/components/ReviewEditor.tsx
//   inception-{projectId}                    frontend/src/hooks/useCollaborativeInception.ts
//   discussion-{sprintId}-{discussionId}     discussions feature (Yjs chat doc)
//   intent-review-{intentId}-{humanTaskId}   v2 stage review feedback
//   intent-artifact-{intentId}-{artifactId}  v2 post-hoc artifact editing
const YJS_DOC_VECTORS = [
  [`presence-${SPRINT_ID}`, `sprint:${SPRINT_ID}`],
  [`sq-${SPRINT_ID}-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`requirement-${SPRINT_ID}-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`userstory-${SPRINT_ID}-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`task-${SPRINT_ID}-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`review-${SPRINT_ID}-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`review-${SPRINT_ID}-pending`, `sprint:${SPRINT_ID}`],
  [`discussion-${SPRINT_ID}-disc-${ARTIFACT_ID}`, `sprint:${SPRINT_ID}`],
  [`inception-${PROJECT_ID}`, `project:${PROJECT_ID}`],
  // V2 intent collaboration docs use intent-specific prefixes.
  [`intent-sq-${INTENT_ID}-${ARTIFACT_ID}`, `intent:${INTENT_ID}`],
  [`intent-discussion-${INTENT_ID}-disc-${ARTIFACT_ID}`, `intent:${INTENT_ID}`],
  [`intent-presence-${INTENT_ID}`, `intent:${INTENT_ID}`],
  [`intent-review-${INTENT_ID}-ht-${ARTIFACT_ID}`, `intent:${INTENT_ID}`],
  // Post-hoc artifact editing (v2 documents). Artifact ids are agent-chosen
  // slugs, not UUIDs — they ride the free suffix after the intent UUID.
  [`intent-artifact-${INTENT_ID}-${ARTIFACT_ID}`, `intent:${INTENT_ID}`],
  [`intent-artifact-${INTENT_ID}-market-research`, `intent:${INTENT_ID}`],
  // Unknown formats → deny (null)
  ['default', null],
  ['', null],
  [`sprint:${SPRINT_ID}`, null], // app-WS channel format is NOT a Yjs doc name
  [`intent:${INTENT_ID}`, null], // app-WS channel format is NOT a Yjs doc name
  [`presence-`, null],
  [`presence-not-a-uuid`, null],
  [`inception-${PROJECT_ID}-extra`, null],
  [`intent-sq-not-a-uuid`, null],
  [`evil-${SPRINT_ID}`, null],
  [SPRINT_ID, null],
];

const CHANNEL_VECTORS = [
  [`sprint:${SPRINT_ID}`, `sprint:${SPRINT_ID}`],
  [`intent:${INTENT_ID}`, `intent:${INTENT_ID}`],
  [PROJECT_ID, `project:${PROJECT_ID}`],
  // Unknown formats → deny (null)
  ['default', null],
  ['', null],
  [`sprint:not-a-uuid`, null],
  [`intent:not-a-uuid`, null],
  [`sprint:`, null],
  [`intent:`, null],
  [`project:${PROJECT_ID}`, null], // channels use the bare projectId, not a prefix
  [`presence-${SPRINT_ID}`, null],
];

const impls = [
  ['yjs-server copy', yjsImpl],
  ['shared module', sharedImpl],
];

describe.each(impls)('scope extractors (%s)', (_name, impl) => {
  it.each(YJS_DOC_VECTORS)('requiredScopeForYjsDoc(%j) -> %j', (docName, expected) => {
    expect(impl.requiredScopeForYjsDoc(docName)).toBe(expected);
  });

  it.each(CHANNEL_VECTORS)('requiredScopeForChannel(%j) -> %j', (documentId, expected) => {
    expect(impl.requiredScopeForChannel(documentId)).toBe(expected);
  });

  it('rejects non-string inputs', () => {
    expect(impl.requiredScopeForYjsDoc(undefined)).toBe(null);
    expect(impl.requiredScopeForYjsDoc(null)).toBe(null);
    expect(impl.requiredScopeForChannel(undefined)).toBe(null);
    expect(impl.requiredScopeForChannel(null)).toBe(null);
  });
});

describe.each(impls)('token sign/verify (%s)', (_name, impl) => {
  const SECRET = 'test-secret-0123456789';
  const NOW = 1_700_000_000_000;

  it('roundtrips a valid token', () => {
    const { token, exp } = impl.signRealtimeToken(
      { sub: 'user-1', scopes: [`sprint:${SPRINT_ID}`], now: NOW },
      SECRET,
    );
    expect(exp).toBe(Math.floor(NOW / 1000) + 600);
    const verified = impl.verifyRealtimeToken(token, SECRET, { now: NOW });
    expect(verified.ok).toBe(true);
    expect(verified.payload.sub).toBe('user-1');
    expect(verified.payload.scopes).toEqual([`sprint:${SPRINT_ID}`]);
  });

  it('rejects an expired token', () => {
    const { token } = impl.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], ttlSeconds: 10, now: NOW },
      SECRET,
    );
    const verified = impl.verifyRealtimeToken(token, SECRET, { now: NOW + 11_000 });
    expect(verified).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a forged signature', () => {
    const { token } = impl.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], now: NOW },
      SECRET,
    );
    const verified = impl.verifyRealtimeToken(token, 'other-secret', { now: NOW });
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload', () => {
    const { token } = impl.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], now: NOW },
      SECRET,
    );
    const [, sig] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ v: 1, sub: 'attacker', scopes: ['sprint:y'], iat: 0, exp: 9999999999 }),
    ).toString('base64url');
    const verified = impl.verifyRealtimeToken(`${tamperedPayload}.${sig}`, SECRET, { now: NOW });
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each(['', 'no-dot', '.leading', 'trailing.', 'a.b.c-extra-garbage!!'])(
    'rejects malformed token %j',
    (bad) => {
      const verified = impl.verifyRealtimeToken(bad, SECRET);
      expect(verified.ok).toBe(false);
    },
  );

  it('verifyRealtimeAccess enforces scope coverage and sub binding', () => {
    const { token } = impl.signRealtimeToken(
      { sub: 'user-1', scopes: [`sprint:${SPRINT_ID}`, `project:${PROJECT_ID}`], now: NOW },
      SECRET,
    );
    const base = { token, secret: SECRET, sub: 'user-1', now: NOW };

    expect(impl.verifyRealtimeAccess({ ...base, requiredScope: `sprint:${SPRINT_ID}` }).ok).toBe(
      true,
    );
    expect(impl.verifyRealtimeAccess({ ...base, requiredScope: `project:${PROJECT_ID}` }).ok).toBe(
      true,
    );
    expect(impl.verifyRealtimeAccess({ ...base, requiredScope: 'sprint:other' })).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
    expect(
      impl.verifyRealtimeAccess({ ...base, requiredScope: `sprint:${SPRINT_ID}`, sub: 'user-2' }),
    ).toEqual({ ok: false, reason: 'sub_mismatch' });
    expect(impl.verifyRealtimeAccess({ ...base, requiredScope: null })).toEqual({
      ok: false,
      reason: 'unknown_scope',
    });
    expect(
      impl.verifyRealtimeAccess({
        token: null,
        secret: SECRET,
        requiredScope: 'sprint:x',
        sub: 'u',
      }),
    ).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('isTokenLive filters expired rows, allows live and legacy rows', () => {
    const nowSec = Math.floor(NOW / 1000);
    expect(impl.isTokenLive(nowSec + 60, NOW)).toBe(true);
    expect(impl.isTokenLive(nowSec - 1, NOW)).toBe(false);
    expect(impl.isTokenLive(undefined, NOW)).toBe(true); // pre-enforcement legacy row
    expect(impl.isTokenLive(null, NOW)).toBe(true);
    expect(impl.isTokenLive(String(nowSec + 60), NOW)).toBe(true); // DDB N-as-string
    expect(impl.isTokenLive(String(nowSec - 1), NOW)).toBe(false);
  });
});

describe('cross-implementation parity', () => {
  it('tokens signed by one implementation verify with the other', () => {
    const SECRET = 'parity-secret';
    const NOW = 1_700_000_000_000;
    const a = yjsImpl.signRealtimeToken({ sub: 'u', scopes: ['sprint:x'], now: NOW }, SECRET);
    const b = sharedImpl.signRealtimeToken({ sub: 'u', scopes: ['sprint:x'], now: NOW }, SECRET);
    expect(a.token).toBe(b.token);
    expect(sharedImpl.verifyRealtimeToken(a.token, SECRET, { now: NOW }).ok).toBe(true);
    expect(yjsImpl.verifyRealtimeToken(b.token, SECRET, { now: NOW }).ok).toBe(true);
  });
});
