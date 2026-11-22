import { useEffect, useState } from 'react';
import { agentsService } from '@/services/agents';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';

export function StageRoleEnforcementSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    agentsService.getStageRoleEnforcement().then(
      (settings) => {
        if (active) setEnabled(settings.enforceStageRoles);
      },
      () => {
        if (active) setError('Could not load stage role enforcement.');
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const save = async (checked: boolean) => {
    setSaving(true);
    setError('');
    try {
      await agentsService.updateSettings({ enforceStageRoles: checked });
      setEnabled(checked);
    } catch {
      setError('Could not save stage role enforcement.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {enabled === null ? (
        !error && <Skeleton className="h-6 w-full" />
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div>
            <label htmlFor="enforce-stage-roles" className="text-sm font-medium">
              Enforce business roles
            </label>
            <p id="enforce-stage-roles-description" className="mt-1 text-xs text-muted-foreground">
              Set the platform default for stage edits and decisions, including on intents in
              progress. Space Owners can override this in Space Settings → Members.
            </p>
          </div>
          <Switch
            id="enforce-stage-roles"
            aria-describedby="enforce-stage-roles-description"
            checked={enabled}
            disabled={saving}
            onCheckedChange={save}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
