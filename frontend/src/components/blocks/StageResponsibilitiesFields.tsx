import { useId } from 'react';
import type { BusinessRole } from '@/services/projects';
import type { StagePermissions } from '@/services/workflows';

export function StageResponsibilitiesFields({
  value,
  roles,
  onChange,
  disabled,
  readOnly,
}: {
  value: StagePermissions | null;
  roles: BusinessRole[];
  disabled?: boolean;
} & (
  | { readOnly: true; onChange?: never }
  | { readOnly?: boolean; onChange: (value: StagePermissions | null) => void }
)) {
  const id = useId();
  const permissions = value ?? { decisionMakerRoles: [], contributorRoles: [] };
  const setValue = (next: StagePermissions) => {
    if (!readOnly) {
      const { automatic: _, ...assigned } = next;
      // Clearing the last role removes the mapping instead of saving empty
      // lists, which would make Space Owners decide.
      onChange(
        assigned.decisionMakerRoles.length || assigned.contributorRoles.length ? assigned : null,
      );
    }
  };
  return (
    <section aria-label="Stage responsibilities">
      {!readOnly && !roles.length && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          The business role catalog is unavailable. Reload to configure responsibilities.
        </p>
      )}
      <fieldset disabled={disabled || readOnly || !roles.length}>
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ['decisionMakerRoles', 'Decision Makers'],
              ['contributorRoles', 'Contributors'],
            ] as const
          ).map(([field, title]) => (
            <fieldset key={field} className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{title}</legend>
              {[
                ...roles,
                ...(readOnly
                  ? permissions[field]
                      .filter((role) => !roles.some(({ id: roleId }) => roleId === role))
                      .map((role) => ({ id: role, name: role }))
                  : []),
              ].map((role) => (
                <label
                  key={role.id}
                  htmlFor={`${id}-${field}-${role.id}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    id={`${id}-${field}-${role.id}`}
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    aria-label={`${title}: ${role.name}`}
                    checked={permissions[field].includes(role.id)}
                    onChange={(event) =>
                      setValue({
                        ...permissions,
                        [field]: event.target.checked
                          ? [...permissions[field], role.id]
                          : permissions[field].filter((selected) => selected !== role.id),
                      })
                    }
                  />
                  {role.name}
                </label>
              ))}
              {!roles.length && !permissions[field].length && (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </fieldset>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
