import { describe, expect, it } from 'vitest';
import type { Member } from '@/services/projects';
import type { StageResponsibilities } from '@/services/stageResponsibilities';
import { previewMemberResponsibilities } from './memberPreview';

const preview: StageResponsibilities = {
  previewOnly: true,
  workflowId: 'flow',
  workflowVersion: 3,
  roles: [],
  stages: [
    {
      stageId: 'design',
      stageInstanceId: null,
      gateIds: [],
      name: 'Design',
      permissions: { decisionMakerRoles: ['architect'], contributorRoles: ['developer'] },
      reason: 'decision-makers',
      decisionMakers: [{ userId: 'alice', name: 'Alice', roles: ['architect'] }],
      contributors: [],
      missingDecisionMakerRoles: [],
      missingContributorRoles: ['developer'],
    },
  ],
};

describe('member responsibility preview', () => {
  it('uses saved effective roles for SSO exclusions and restores while preserving profiles', () => {
    const alice: Member = {
      userId: 'alice',
      role: 'member',
      ssoRoles: ['architect'],
      localRoles: ['developer'],
      excludedRoles: ['architect'],
      effectiveRoles: ['developer'],
    };
    const stage = previewMemberResponsibilities(preview, [alice]).stages[0];
    expect(stage.reason).toBe('contributors');
    expect(stage.contributors).toEqual([
      { userId: 'alice', name: 'Alice', email: undefined, roles: ['developer'] },
    ]);
    expect(stage.missingDecisionMakerRoles).toEqual(['architect']);
    expect(stage.missingContributorRoles).toEqual([]);
    const restored = previewMemberResponsibilities(preview, [
      { ...alice, excludedRoles: [], effectiveRoles: ['architect', 'developer'] },
    ]).stages[0];
    expect(restored.reason).toBe('decision-makers');
    expect(restored.missingDecisionMakerRoles).toEqual([]);
    expect(preview.stages[0].reason).toBe('decision-makers');
  });

  it('excludes viewers and falls back to owners when the last eligible assignment is removed', () => {
    const stage = previewMemberResponsibilities(preview, [
      { userId: 'alice', role: 'viewer', effectiveRoles: ['architect', 'developer'] },
      { userId: 'owner', role: 'owner', effectiveRoles: [] },
    ]).stages[0];
    expect(stage.reason).toBe('owners');
    expect(stage.decisionMakers.map((person) => person.userId)).toEqual(['owner']);
    expect(stage.contributors).toEqual([]);
    expect(stage.missingDecisionMakerRoles).toEqual(['architect']);
    expect(stage.missingContributorRoles).toEqual(['developer']);
  });

  it('keeps automatic and unmapped stages intact', () => {
    const stages = [
      { ...preview.stages[0], reason: 'automatic' as const },
      { ...preview.stages[0], reason: 'unmapped' as const, permissions: null },
    ];
    expect(previewMemberResponsibilities({ ...preview, stages }, []).stages).toEqual(stages);
  });
});
