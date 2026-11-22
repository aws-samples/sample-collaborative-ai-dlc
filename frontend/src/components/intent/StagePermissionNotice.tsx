import { ShieldUser, UsersRound } from 'lucide-react';
import { useIntent } from '@/contexts/IntentContext';
import type { GateResponsibility } from '@/services/stageResponsibilities';
import {
  StageResponsibilitiesTable,
  StageRoleEnforcementOffNotice,
} from '@/components/stage-responsibilities/StageResponsibilitiesTable';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function StagePermissionNotice({
  stage,
  review = false,
  access,
}: {
  stage?: GateResponsibility;
  access?: GateResponsibility['access'];
  review?: boolean;
}) {
  const { projectId, intentId, enforceStageRoles } = useIntent();
  const noun = review ? 'feedback' : 'answers';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>
        {!access
          ? 'Stage permissions unavailable.'
          : access.decide
            ? review
              ? 'You can make this decision.'
              : 'You can edit and submit answers.'
            : access.edit
              ? `You can edit ${noun}.`
              : 'You have read-only access to this stage.'}
      </span>
      <Popover>
        <PopoverTrigger aria-label="Who can act?" title="Who can act?">
          <ShieldUser size={16} />
        </PopoverTrigger>
        <PopoverContent className="w-80 space-y-3">
          {enforceStageRoles === false && <StageRoleEnforcementOffNotice />}
          {enforceStageRoles !== false && !stage && access && (
            <p>No roles are configured. Space Owners and Members can edit and decide.</p>
          )}
          {stage &&
            (stage.reason === 'unmapped' ? (
              <p>No roles are configured. Space Owners and Members can edit and decide.</p>
            ) : (
              <>
                <table className="w-full border text-left text-sm">
                  <tbody>
                    {(['decisionMakers', 'contributors'] as const).map((key) => (
                      <tr className="border-b" key={key}>
                        <th className="p-2">
                          {key === 'decisionMakers' ? 'Decision Makers' : 'Contributors'}
                          <small className="block font-normal">
                            {key === 'decisionMakers'
                              ? review
                                ? 'Can edit feedback and decide'
                                : 'Can edit and submit answers'
                              : `Can edit ${noun}`}
                          </small>
                        </th>
                        <td className="p-2">
                          {stage[key].map((p) => p.name || p.email || p.userId).join(', ') ||
                            'None'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {stage.reason === 'contributors' && (
                  <p>No current member has a Decision Maker role. Contributors can decide.</p>
                )}
                {stage.reason === 'owners' && (
                  <p>
                    No current member has a Decision Maker or Contributor role. Space Owners can
                    decide.
                  </p>
                )}
              </>
            ))}
          <Dialog>
            <DialogTrigger className="flex items-center gap-2">
              <UsersRound size={16} />
              Stage responsibilities
            </DialogTrigger>
            <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-4xl">
              <DialogTitle>Stage responsibilities</DialogTitle>
              <StageResponsibilitiesTable projectId={projectId} intentId={intentId} />
            </DialogContent>
          </Dialog>
        </PopoverContent>
      </Popover>
    </div>
  );
}
