import { describe, it, expect } from 'vitest';
import * as realtime from '../../shared/realtime-token.js';

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
//   intent-artifact-{intentId}-{artifactId}-epoch-{epoch}  v2 post-hoc artifact editing
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
  [`intent-artifact-${INTENT_ID}-market-research-epoch-${ARTIFACT_ID}`, `intent:${INTENT_ID}`],
  // Collaborative DRAFT compose page (shared prompt + grid selection).
  [`intent-draft-${INTENT_ID}`, `intent:${INTENT_ID}`],
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

describe('realtime scopes', () => {
  it.each(YJS_DOC_VECTORS)('requiredScopeForYjsDoc(%j) -> %j', (docName, expected) => {
    expect(realtime.requiredScopeForYjsDoc(docName)).toBe(expected);
  });

  it.each(CHANNEL_VECTORS)('requiredScopeForChannel(%j) -> %j', (documentId, expected) => {
    expect(realtime.requiredScopeForChannel(documentId)).toBe(expected);
  });

  it('rejects non-string inputs', () => {
    expect(realtime.requiredScopeForYjsDoc(undefined)).toBe(null);
    expect(realtime.requiredScopeForYjsDoc(null)).toBe(null);
    expect(realtime.requiredScopeForChannel(undefined)).toBe(null);
    expect(realtime.requiredScopeForChannel(null)).toBe(null);
  });
});

describe('realtime token sign/verify', () => {
  const SECRET = 'test-secret-0123456789';
  const NOW = 1_700_000_000_000;

  it('roundtrips a valid token', () => {
    const { token, exp } = realtime.signRealtimeToken(
      { sub: 'user-1', scopes: [`sprint:${SPRINT_ID}`], now: NOW },
      SECRET,
    );
    expect(exp).toBe(Math.floor(NOW / 1000) + 600);
    const verified = realtime.verifyRealtimeToken(token, SECRET, { now: NOW });
    expect(verified.ok).toBe(true);
    expect(verified.payload.sub).toBe('user-1');
    expect(verified.payload.scopes).toEqual([`sprint:${SPRINT_ID}`]);
  });

  it('rejects an expired token', () => {
    const { token } = realtime.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], ttlSeconds: 10, now: NOW },
      SECRET,
    );
    const verified = realtime.verifyRealtimeToken(token, SECRET, { now: NOW + 11_000 });
    expect(verified).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a forged signature', () => {
    const { token } = realtime.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], now: NOW },
      SECRET,
    );
    const verified = realtime.verifyRealtimeToken(token, 'other-secret', { now: NOW });
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload', () => {
    const { token } = realtime.signRealtimeToken(
      { sub: 'user-1', scopes: ['sprint:x'], now: NOW },
      SECRET,
    );
    const [, sig] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ v: 1, sub: 'attacker', scopes: ['sprint:y'], iat: 0, exp: 9999999999 }),
    ).toString('base64url');
    const verified = realtime.verifyRealtimeToken(`${tamperedPayload}.${sig}`, SECRET, {
      now: NOW,
    });
    expect(verified).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each(['', 'no-dot', '.leading', 'trailing.', 'a.b.c-extra-garbage!!'])(
    'rejects malformed token %j',
    (bad) => {
      const verified = realtime.verifyRealtimeToken(bad, SECRET);
      expect(verified.ok).toBe(false);
    },
  );

  it('verifyRealtimeAccess enforces scope coverage and sub binding', () => {
    const { token } = realtime.signRealtimeToken(
      { sub: 'user-1', scopes: [`sprint:${SPRINT_ID}`, `project:${PROJECT_ID}`], now: NOW },
      SECRET,
    );
    const base = { token, secret: SECRET, sub: 'user-1', now: NOW };

    expect(
      realtime.verifyRealtimeAccess({ ...base, requiredScope: `sprint:${SPRINT_ID}` }).ok,
    ).toBe(true);
    expect(
      realtime.verifyRealtimeAccess({ ...base, requiredScope: `project:${PROJECT_ID}` }).ok,
    ).toBe(true);
    expect(realtime.verifyRealtimeAccess({ ...base, requiredScope: 'sprint:other' })).toEqual({
      ok: false,
      reason: 'scope_mismatch',
    });
    expect(
      realtime.verifyRealtimeAccess({
        ...base,
        requiredScope: `sprint:${SPRINT_ID}`,
        sub: 'user-2',
      }),
    ).toEqual({ ok: false, reason: 'sub_mismatch' });
    expect(realtime.verifyRealtimeAccess({ ...base, requiredScope: null })).toEqual({
      ok: false,
      reason: 'unknown_scope',
    });
    expect(
      realtime.verifyRealtimeAccess({
        token: null,
        secret: SECRET,
        requiredScope: 'sprint:x',
        sub: 'u',
      }),
    ).toEqual({ ok: false, reason: 'missing_token' });
  });

  it('isTokenLive filters expired rows, allows live and legacy rows', () => {
    const nowSec = Math.floor(NOW / 1000);
    expect(realtime.isTokenLive(nowSec + 60, NOW)).toBe(true);
    expect(realtime.isTokenLive(nowSec - 1, NOW)).toBe(false);
    expect(realtime.isTokenLive(undefined, NOW)).toBe(true); // pre-enforcement legacy row
    expect(realtime.isTokenLive(null, NOW)).toBe(true);
    expect(realtime.isTokenLive(String(nowSec + 60), NOW)).toBe(true); // DDB N-as-string
    expect(realtime.isTokenLive(String(nowSec - 1), NOW)).toBe(false);
  });
});
