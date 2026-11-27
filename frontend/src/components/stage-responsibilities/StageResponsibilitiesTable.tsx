import { useEffect, useState } from 'react';
import { Loader2, UserRoundX } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { Member } from '@/services/projects';
import { previewMemberResponsibilities } from './memberPreview';
import {
  stageResponsibilitiesService,
  type StageResponsibilities,
  type ResponsiblePerson,
} from '@/services/stageResponsibilities';

function MissingRoles({ roles, group, empty }: { roles: string[]; group: string; empty: boolean }) {
  const [open, setOpen] = useState(false);
  const icon = (
    <UserRoundX
      className="h-6 w-6 text-agent-warning"
      role="img"
      aria-label="No members"
      aria-hidden={false}
    />
  );
  if (!roles.length) return empty ? <span className="block pl-2">{icon}</span> : null;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={
            empty
              ? 'block rounded-sm px-2 text-agent-warning focus-visible:outline focus-visible:outline-2'
              : 'mt-3 rounded-sm text-xs text-agent-warning focus-visible:outline focus-visible:outline-2'
          }
          aria-label={empty ? `No members. Unassigned ${group}: ${roles.join(', ')}` : undefined}
          onClick={(event) => {
            // Keep the tooltip available on touch and keyboard activation as well as hover.
            event.preventDefault();
            setOpen(true);
          }}
        >
          {empty ? icon : `${roles.length} unassigned ${roles.length === 1 ? 'role' : 'roles'}`}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-bold">Unassigned {group}:</p>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {roles.map((role) => (
            <li key={role}>{role}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export function StageRoleEnforcementOffNotice() {
  return (
    <p className="text-sm text-muted-foreground">
      <strong>Business role enforcement is off.</strong> Space Owners and Members can answer and
      approve stage questions regardless of their assigned business roles. A Space Owner can turn
      enforcement on in Space Settings → Members.
    </p>
  );
}

export function StageResponsibilitiesTable({
  projectId,
  intentId,
  refreshVersion = 0,
  members,
}: {
  projectId: string;
  intentId?: string;
  refreshVersion?: number;
  members?: Member[];
}) {
  const [confirmed, setConfirmed] = useState<{
    data: StageResponsibilities;
    refreshVersion: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConfirmed(null);
  }, [projectId, intentId]);
  useEffect(() => {
    let active = true;
    setError(null);
    stageResponsibilitiesService
      .get(projectId, intentId ? { intentId } : {})
      .then((result) => {
        if (!active) return;
        setConfirmed({ data: result, refreshVersion });
      })
      .catch((err) => {
        if (active)
          setError(err instanceof Error ? err.message : 'Could not load responsibilities');
      });
    return () => {
      active = false;
    };
  }, [projectId, intentId, refreshVersion]);
  // Include roles arriving after a member save until the backend confirms that save.
  const responsibilities =
    confirmed?.data.previewOnly && refreshVersion > confirmed.refreshVersion && members
      ? previewMemberResponsibilities(confirmed.data, members)
      : (confirmed?.data ?? null);
  const roleNames = (ids: string[]) =>
    ids.map((id) => responsibilities?.roles.find((role) => role.id === id)?.name || id);
  const peopleList = (
    people: ResponsiblePerson[],
    mappedRoles: string[],
    missingRoles: string[],
    group: string,
    fallback = false,
  ) => (
    <div>
      {!!people.length && (
        <div className="space-y-3">
          {people.map((person) => (
            <div key={person.userId}>
              {person.name || person.email || person.userId}
              <div className="mt-1 text-xs text-muted-foreground">
                {fallback
                  ? 'No current Decision Makers or Contributors. Space Owners decide as fallback.'
                  : roleNames(
                      (person.roles ?? []).filter((role) => mappedRoles.includes(role)),
                    ).join(', ')}
              </div>
            </div>
          ))}
        </div>
      )}
      <MissingRoles roles={roleNames(missingRoles)} group={group} empty={!people.length} />
    </div>
  );
  return (
    <div className="space-y-3">
      {intentId && responsibilities && (
        <p className="text-sm text-muted-foreground">
          {responsibilities.workflowId} · Version {responsibilities.workflowVersion}
        </p>
      )}
      {intentId && responsibilities?.enforceStageRoles === false && (
        <StageRoleEnforcementOffNotice />
      )}
      {error && responsibilities && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <TooltipProvider delayDuration={200}>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm" aria-busy={!responsibilities && !error}>
            <thead className="bg-muted text-[13px]">
              <tr>
                <th className="p-3">Stage</th>
                <th className="p-3">Decision Makers</th>
                <th className="p-3">
                  Contributors
                  <div className="mt-1 text-xs font-normal text-muted-foreground">
                    (Fallbacks when no Decision Makers)
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {error && !responsibilities ? (
                <tr className="border-t">
                  <td colSpan={3} className="p-3">
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  </td>
                </tr>
              ) : !responsibilities ? (
                <tr className="border-t">
                  <td colSpan={3} className="px-3 py-6">
                    <div role="status" className="flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Loading responsibilities…
                    </div>
                  </td>
                </tr>
              ) : (
                responsibilities.stages
                  .filter((stage) => stage.reason !== 'automatic')
                  .map((stage) => (
                    <tr key={stage.stageInstanceId || stage.stageId} className="border-t align-top">
                      <td className="p-3">
                        <span className="capitalize">{stage.name.replaceAll('-', ' ')}</span>
                        {stage.stageInstanceId && (
                          <div className="text-xs text-muted-foreground">
                            {stage.stageInstanceId}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        {stage.reason === 'unmapped'
                          ? 'No role mapping'
                          : peopleList(
                              stage.reason === 'contributors' ? [] : stage.decisionMakers,
                              stage.permissions?.decisionMakerRoles ?? [],
                              stage.missingDecisionMakerRoles ?? [],
                              'Decision Makers',
                              stage.reason === 'owners',
                            )}
                      </td>
                      <td className="p-3">
                        {stage.reason === 'unmapped'
                          ? '—'
                          : peopleList(
                              stage.contributors,
                              stage.permissions?.contributorRoles ?? [],
                              stage.missingContributorRoles ?? [],
                              'Contributors',
                            )}
                      </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      </TooltipProvider>
    </div>
  );
}
