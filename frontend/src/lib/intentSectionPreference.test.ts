import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLastIntentSection,
  setLastIntentSection,
  intentSectionPath,
} from './intentSectionPreference';

describe('intentSectionPreference', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getLastIntentSection', () => {
    it('returns overview when no preference is stored', () => {
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('returns the stored section when valid', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', 'work');
      expect(getLastIntentSection('intent-123')).toBe('work');
    });

    it('returns overview for an invalid stored value', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', 'audit');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('returns overview for garbage stored value', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', 'not-a-section');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('returns overview for an empty string', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', '');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('ignores stale v1 keys (old prefix without v2)', () => {
      localStorage.setItem('aidlc.intentSection.intent-123', 'execution');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('returns overview for legacy value "execution"', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', 'execution');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('returns overview for legacy value "observability"', () => {
      localStorage.setItem('aidlc.intentSection.v2.intent-123', 'observability');
      expect(getLastIntentSection('intent-123')).toBe('overview');
    });

    it('isolates preferences by intent ID', () => {
      setLastIntentSection('a', 'graph');
      setLastIntentSection('b', 'work');
      expect(getLastIntentSection('a')).toBe('graph');
      expect(getLastIntentSection('b')).toBe('work');
      expect(getLastIntentSection('c')).toBe('overview');
    });

    it('accepts all three valid sections', () => {
      for (const section of ['overview', 'work', 'graph'] as const) {
        localStorage.setItem('aidlc.intentSection.v2.valid-check', section);
        expect(getLastIntentSection('valid-check')).toBe(section);
      }
    });
  });

  describe('setLastIntentSection', () => {
    it('persists a valid section', () => {
      setLastIntentSection('i1', 'graph');
      expect(localStorage.getItem('aidlc.intentSection.v2.i1')).toBe('graph');
    });

    it('overwrites a previous preference', () => {
      setLastIntentSection('i1', 'work');
      setLastIntentSection('i1', 'overview');
      expect(getLastIntentSection('i1')).toBe('overview');
    });
  });

  describe('intentSectionPath', () => {
    it('returns observability route for overview', () => {
      expect(intentSectionPath('p1', 'i1', 'overview')).toBe('/space/p1/intent/i1/observability');
    });

    it('returns root intent route for work', () => {
      expect(intentSectionPath('p1', 'i1', 'work')).toBe('/space/p1/intent/i1');
    });

    it('returns graph route for graph', () => {
      expect(intentSectionPath('p1', 'i1', 'graph')).toBe('/space/p1/intent/i1/graph');
    });
  });
});
