import { api } from './api';
import type { BusinessRole } from './projects';
import type { StagePermissions } from './workflows';

export interface ResponsiblePerson {
  userId: string;
  name?: string;
  email?: string;
  roles: string[];
}
export interface StageResponsibility {
  stageId: string;
  stageInstanceId: string | null;
  gateIds: string[];
  access?: { edit: boolean; decide: boolean };
  name: string;
  phasePath?: string | null;
  permissions: StagePermissions | null;
  reason: 'decision-makers' | 'contributors' | 'owners' | 'automatic' | 'unmapped';
  missingDecisionMakerRoles: string[];
  missingContributorRoles: string[];
  decisionMakers: ResponsiblePerson[];
  contributors: ResponsiblePerson[];
}
export type GateResponsibility = Pick<
  StageResponsibility,
  'access' | 'contributors' | 'decisionMakers'
> & { reason: StageResponsibility['reason'] | 'section' };
export interface StageResponsibilities {
  enforceStageRoles?: boolean;
  sectionGates?: Record<string, GateResponsibility>;
  unattributedAccess?: StageResponsibility['access'];
  previewOnly: boolean;
  workflowId: string;
  workflowVersion: number;
  roles: BusinessRole[];
  stages: StageResponsibility[];
}

export const stageResponsibilitiesService = {
  get: (
    projectId: string,
    selection: {
      workflowId?: string;
      version?: number;
      scope?: string;
      intentId?: string;
      stageInstanceId?: string;
      actorAccess?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(selection)) {
      if (value != null && value !== '') params.set(key, String(value));
    }
    return api.get<StageResponsibilities>(
      `/projects/${projectId}/stage-responsibilities${params.size ? `?${params}` : ''}`,
    );
  },
};
