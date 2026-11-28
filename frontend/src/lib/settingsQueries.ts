import { api } from '@/services/api';
import { queryOptions, type QueryFunctionContext, type QueryKey } from '@tanstack/react-query';
import { qk } from './queryKeys';
import type { AgentCredentialStatus, SpaceAgentCredentialStatus } from '@/services/agents';

const SETTINGS_STALE_MS = 30_000;

const get =
  <T>(path: string) =>
  ({ signal }: QueryFunctionContext) =>
    api.get<T>(path, { signal });

const summary = <T>(queryKey: QueryKey, path: string, staleTime = SETTINGS_STALE_MS) =>
  queryOptions({ queryKey, gcTime: 5 * 60_000, staleTime, queryFn: get<T>(path) });

// ── Space ──

export const projectCredentialsQuery = (projectId: string) =>
  summary<SpaceAgentCredentialStatus>(
    qk.projectCredentials(projectId),
    `/projects/${projectId}/agent-credentials`,
  );

// ── Account ──

export const personalCredentialsQuery = () =>
  summary<AgentCredentialStatus>(qk.personalCredentials(), '/users/me/agent-credentials');
