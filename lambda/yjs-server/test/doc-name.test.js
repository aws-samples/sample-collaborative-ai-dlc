import { describe, it, expect } from 'vitest';
import { docNameFromPath } from '../doc-name.js';
import { requiredScopeForYjsDoc } from '../realtime-token.js';

const SPRINT = 'b6326738-6b97-4819-829a-565ee8903e38';
const PROJECT = 'de310884-13d5-42c1-ac60-8ba696980c7a';

describe('docNameFromPath', () => {
  it('uses the path as docName for direct connections (local dev)', () => {
    expect(docNameFromPath(`/presence-${SPRINT}`)).toBe(`presence-${SPRINT}`);
    expect(docNameFromPath(`/discussion-${SPRINT}-disc-1`)).toBe(`discussion-${SPRINT}-disc-1`);
  });

  it('strips the CloudFront /yjs/* routing prefix (deployed path shape)', () => {
    expect(docNameFromPath(`/yjs/presence-${SPRINT}`)).toBe(`presence-${SPRINT}`);
    expect(docNameFromPath(`/yjs/inception-${PROJECT}`)).toBe(`inception-${PROJECT}`);
    expect(docNameFromPath(`/yjs/discussion-${SPRINT}-disc-1`)).toBe(`discussion-${SPRINT}-disc-1`);
  });

  it('strips the prefix at most once', () => {
    expect(docNameFromPath('/yjs/yjs/foo')).toBe('yjs/foo');
  });

  it('falls back to "default" for empty paths', () => {
    expect(docNameFromPath('/')).toBe('default');
    expect(docNameFromPath('/yjs/')).toBe('default');
    expect(docNameFromPath(undefined)).toBe('default');
  });

  // Regression: behind CloudFront every doc arrived as `yjs/<docName>`, which
  // the anchored scope patterns rejected (`unknown_scope`) — killing ALL Yjs
  // sync (presence, structured answers, inception, discussions) once doc-token
  // enforcement went live.
  it('yields doc names the scope extractor recognizes for deployed paths', () => {
    expect(requiredScopeForYjsDoc(docNameFromPath(`/yjs/discussion-${SPRINT}-disc-1`))).toBe(
      `sprint:${SPRINT}`,
    );
    expect(requiredScopeForYjsDoc(docNameFromPath(`/yjs/inception-${PROJECT}`))).toBe(
      `project:${PROJECT}`,
    );
    expect(requiredScopeForYjsDoc(docNameFromPath(`/presence-${SPRINT}`))).toBe(`sprint:${SPRINT}`);
  });
});
