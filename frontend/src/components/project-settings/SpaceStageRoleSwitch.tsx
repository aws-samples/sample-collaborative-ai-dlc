import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { projectsService, type SpaceStageRoleEnforcement } from '@/services/projects';

export function SpaceStageRoleSwitch({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const [setting, setSetting] = useState<SpaceStageRoleEnforcement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    projectsService.getStageRoleEnforcement(projectId).then(
      (value) => {
        if (active) setSetting(value);
      },
      () => {
        if (active) setError('Could not load business role enforcement.');
      },
    );
    return () => {
      active = false;
    };
  }, [projectId]);

  const save = async (override: boolean | null) => {
    setSaving(true);
    setError('');
    try {
      setSetting(await projectsService.setStageRoleEnforcement(projectId, override));
    } catch {
      setError('Could not save business role enforcement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-4 space-y-2">
      {setting ? (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <label htmlFor="space-enforce-stage-roles" className="text-sm font-medium">
                Enforce business roles
              </label>
              <p id="space-stage-roles-description" className="text-xs text-muted-foreground">
                {setting.enforceStageRoles
                  ? 'Stage responsibilities determine who can edit and decide in this space'
                  : 'Space Owners and Members can answer and approve stage questions'}
              </p>
            </div>
            <Switch
              id="space-enforce-stage-roles"
              aria-describedby="space-stage-roles-description"
              checked={setting.enforceStageRoles}
              disabled={!canManage || saving}
              onCheckedChange={save}
            />
          </div>
          {canManage && setting.override !== null && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              disabled={saving}
              onClick={() => save(null)}
            >
              Use platform default
            </Button>
          )}
        </>
      ) : (
        !error && <Skeleton className="h-6 w-full" />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
