import { describe, it, expect } from 'vitest';
import {
  isDocumentArtifact,
  detectDocCommonSuffix,
  stripDocSuffix,
  humanizeStageId,
  docProvenance,
} from './documentHelpers';
import type { IntentArtifact } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';

const LONG = `# Heading\n\n${'Long-form markdown body. '.repeat(40)}`;

const artifact = (over: Partial<IntentArtifact> = {}): IntentArtifact => ({
  id: 'a1',
  artifactType: 'requirements',
  title: 'A doc',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-a',
  createdAt: '2026-01-01T00:00:00Z',
  content: LONG,
  ...over,
});

const row = (over: Partial<IntentStageRow> = {}): IntentStageRow => ({
  stageId: 'requirements-analysis',
  phase: '01',
  state: 'SUCCEEDED',
  stageInstanceId: 'si-a',
  unitSlug: null,
  runtimeError: null,
  startedAt: null,
  completedAt: null,
  waitMs: 0,
  parkedAt: null,
  attempt: 0,
  cli: null,
  resolvedModel: null,
  order: 1,
  planned: true,
  ...over,
});

const PHASE_NAMES: Record<string, string> = { '01': 'Inception', '02': 'Construction' };
const phaseNameOf = (path: string) =>
  PHASE_NAMES[path] ?? (path ? path.charAt(0).toUpperCase() + path.slice(1) : path);

describe('isDocumentArtifact', () => {
  it('treats long markdown as a document', () => {
    expect(isDocumentArtifact(artifact())).toBe(true);
  });

  it('rejects short content with a non-document type', () => {
    expect(
      isDocumentArtifact(
        artifact({ artifactType: 'practices-discovery-timestamp', content: 'ts: now' }),
      ),
    ).toBe(false);
  });

  it('accepts a document-ish type even when short', () => {
    expect(isDocumentArtifact(artifact({ artifactType: 'research-report', content: 'x' }))).toBe(
      true,
    );
  });
});

describe('detectDocCommonSuffix', () => {
  it('detects a dash-tail suffix that recurs across titles', () => {
    const titles = [
      'Build and Test Results — Plant Identifier MVP',
      'Build Instructions — Plant Identifier MVP',
      'Code Summary — Infrastructure (Plant Identifier MVP)',
    ];
    expect(detectDocCommonSuffix(titles)).toBe('Plant Identifier MVP');
  });

  it('returns null when no trailing suffix recurs', () => {
    expect(detectDocCommonSuffix(['Requirements — Alpha', 'Design — Beta'])).toBeNull();
  });
});

describe('stripDocSuffix', () => {
  const token = 'Plant Identifier MVP';

  it('removes a dash-form suffix entirely', () => {
    expect(stripDocSuffix('Build and Test Results — Plant Identifier MVP', token)).toBe(
      'Build and Test Results',
    );
  });

  it('removes a parenthetical-form suffix but keeps a meaningful earlier dash segment', () => {
    expect(stripDocSuffix('Code Summary — Infrastructure (Plant Identifier MVP)', token)).toBe(
      'Code Summary — Infrastructure',
    );
  });

  it('is a no-op when the token does not appear in the title', () => {
    expect(stripDocSuffix('Requirements — Alpha', token)).toBe('Requirements — Alpha');
  });

  it('is a no-op with null token', () => {
    expect(stripDocSuffix('Build Instructions — Plant Identifier MVP', null)).toBe(
      'Build Instructions — Plant Identifier MVP',
    );
  });
});

describe('humanizeStageId', () => {
  it('replaces dashes and underscores with spaces and capitalizes words', () => {
    expect(humanizeStageId('requirements-analysis')).toBe('Requirements Analysis');
    expect(humanizeStageId('build_and_test')).toBe('Build And Test');
  });
});

describe('docProvenance', () => {
  it('joins an artifact to its stage row by stageInstanceId', () => {
    const getProvenance = docProvenance([row()], phaseNameOf);
    const prov = getProvenance(artifact());
    expect(prov.stageId).toBe('requirements-analysis');
    expect(prov.stageLabel).toBe('Requirements Analysis');
    expect(prov.stageOrder).toBe(1);
    expect(prov.phaseLabel).toBe('Inception');
    expect(prov.phasePath).toBe('01');
    expect(prov.unitSlug).toBeNull();
  });

  it('falls back to Other/null when stageInstanceId is missing', () => {
    const getProvenance = docProvenance([row()], phaseNameOf);
    const prov = getProvenance(artifact({ createdByStageInstanceId: 'si-missing' }));
    expect(prov.stageId).toBeNull();
    expect(prov.stageLabel).toBeNull();
    expect(prov.stageOrder).toBe(-1);
    expect(prov.phaseLabel).toBe('Other');
    expect(prov.phasePath).toBe('');
  });

  it('carries unitSlug from the matched row', () => {
    const getProvenance = docProvenance([row({ unitSlug: 'backend' })], phaseNameOf);
    const prov = getProvenance(artifact());
    expect(prov.unitSlug).toBe('backend');
  });
});
