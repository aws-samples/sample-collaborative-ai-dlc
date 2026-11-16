// Admin "Business role mappings" card — maps enterprise IdP values (groups,
// roles, or IDs received through the connection's configured source attribute)
// to the fixed business-role catalog. One mapping per configured SSO
// connection; a provider selector appears only when several are configured.
// Values are entered manually and must match the received value exactly,
// including case — the platform does not verify they exist in the IdP.

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Building2, Pencil, Plus, X, XCircle } from 'lucide-react';
import { ApiError } from '@/services/api';
import {
  ssoRoleMappingsService,
  type SsoMappingProvider,
  type SsoMappingsResponse,
} from '@/services/ssoRoleMappings';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { businessRoleIcon } from '@/components/project-settings/businessRoleIcons';

const BusinessRoleIcon = ({ id }: { id: string }) => {
  const Icon = businessRoleIcon(id);
  return <Icon aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />;
};

export function SsoRoleMappingsCard() {
  const [data, setData] = useState<SsoMappingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  // Mapping modal
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [draftValues, setDraftValues] = useState<string[]>([]);
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await ssoRoleMappingsService.get();
      setData(response);
      setSelectedProviderId((current) =>
        current && response.providers.some((p) => p.providerId === current)
          ? current
          : (response.providers[0]?.providerId ?? null),
      );
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load mappings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const provider: SsoMappingProvider | undefined = data?.providers.find(
    (p) => p.providerId === selectedProviderId,
  );
  const canEdit = !!provider && provider.sourceAttribute !== '';

  const openEditor = (roleId: string) => {
    if (!provider || !canEdit) return;
    setEditingRoleId(roleId);
    setDraftValues([...(provider.roleMappings[roleId] || [])]);
    setNewValue('');
    setSaveError(null);
  };

  const addValue = () => {
    const value = newValue.trim();
    if (!value) return;
    setDraftValues((current) => (current.includes(value) ? current : [...current, value]));
    setNewValue('');
  };

  const handleSave = async () => {
    if (!provider || !editingRoleId || saving) return;
    setSaving(true);
    setSaveError(null);
    const roleMappings = { ...provider.roleMappings };
    if (draftValues.length) roleMappings[editingRoleId] = draftValues;
    else delete roleMappings[editingRoleId];
    try {
      // The loaded revision rides along so a save over someone else's newer
      // edit is rejected (409) instead of silently restoring old values.
      const saved = await ssoRoleMappingsService.save(
        provider.providerId,
        roleMappings,
        provider.revision,
      );
      setData((current) =>
        current
          ? {
              ...current,
              providers: current.providers.map((p) =>
                p.providerId === saved.providerId ? { ...p, ...saved } : p,
              ),
            }
          : current,
      );
      setEditingRoleId(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaveError(
          'This mapping changed since you loaded it. Reload the page and apply your change again.',
        );
      } else {
        setSaveError(e instanceof Error ? e.message : 'Failed to save mapping');
      }
    } finally {
      setSaving(false);
    }
  };

  const roleName = (id: string) => data?.businessRoles.find((role) => role.id === id)?.name || id;

  return (
    <SettingsCard
      icon={<Building2 />}
      title="Business role mappings"
      description="Map company groups or roles received through enterprise SSO to business roles. People signing in through the connection receive the mapped roles; Space Owners can add or exclude roles per space."
    >
      <div className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-xs text-destructive flex items-center gap-1">
            <XCircle className="h-3.5 w-3.5 shrink-0" /> {loadError}
          </p>
        ) : !data || data.providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No enterprise SSO connection is configured. Business roles can still be assigned by
            Space Owners in each space.
          </p>
        ) : (
          <>
            {data.providers.length > 1 ? (
              <div className="space-y-1.5">
                <Label htmlFor="sso-mapping-provider">SSO connection</Label>
                <Select
                  value={selectedProviderId ?? undefined}
                  onValueChange={(value) => setSelectedProviderId(value)}
                >
                  <SelectTrigger
                    id="sso-mapping-provider"
                    className="h-8 w-64 bg-background text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {data.providers.map((p) => (
                      <SelectItem key={p.providerId} value={p.providerId}>
                        {p.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm font-medium">{provider?.displayName}</p>
            )}

            {provider && (
              <p className="text-xs text-muted-foreground">
                {canEdit ? (
                  <>
                    Values are read from the connection's{' '}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                      {provider.sourceAttribute}
                    </code>{' '}
                    attribute. Enter the exact values received from SSO, including case. The
                    platform does not verify they exist in the identity provider.
                  </>
                ) : (
                  'This connection has no source attribute (claims.roles) configured. Complete SSO setup before saving business-role mappings.'
                )}
              </p>
            )}

            {provider && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full min-w-[480px] text-left">
                  <thead className="bg-muted/40 text-[13px] text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-3.5 py-2 font-medium">
                        Business role
                      </th>
                      <th scope="col" className="px-3.5 py-2 font-medium">
                        IdP values
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.businessRoles.map((role) => {
                      const values = provider.effectiveRoleMappings[role.id] || [];
                      const chips = values.length ? (
                        values.map((value) => (
                          <Badge
                            key={value}
                            variant="outline"
                            className="gap-1 bg-background font-mono text-[11px] font-normal"
                          >
                            {value}
                            {provider.terraformRoleMappings[role.id]?.includes(value) && (
                              <span className="font-sans text-muted-foreground">Read-only</span>
                            )}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs text-muted-foreground">No values mapped</span>
                      );
                      return (
                        <tr key={role.id}>
                          <td className="px-3.5 py-2.5">
                            <span className="flex items-center gap-2 text-sm">
                              <BusinessRoleIcon id={role.id} />
                              {role.name}
                            </span>
                          </td>
                          <td className="px-3.5 py-2.5">
                            {canEdit ? (
                              <button
                                type="button"
                                aria-label={`Edit IdP values for ${role.name}`}
                                className="group flex w-full items-center gap-2 rounded-md bg-muted/50 p-2 text-left hover:bg-muted focus-visible:outline-ring"
                                onClick={() => openEditor(role.id)}
                              >
                                <span className="flex flex-1 flex-wrap gap-1">{chips}</span>
                                <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
                              </button>
                            ) : (
                              <div className="flex flex-wrap gap-1 rounded-md bg-muted/50 p-2">
                                {chips}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <Dialog
        open={!!editingRoleId}
        onOpenChange={(open) => {
          if (!open && !saving) setEditingRoleId(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Map IdP values to {editingRoleId ? roleName(editingRoleId) : ''}
            </DialogTitle>
            <DialogDescription>
              Anyone receiving one of these values through {provider?.displayName} gets the{' '}
              {editingRoleId ? roleName(editingRoleId) : ''} role. The same value may also map to
              other business roles.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {!!editingRoleId && !!provider?.terraformRoleMappings[editingRoleId]?.length && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Read-only values. Change these in the infrastructure configuration (Terraform).
                </p>
                <div className="flex flex-wrap gap-2">
                  {provider.terraformRoleMappings[editingRoleId].map((value) => (
                    <Badge
                      key={value}
                      variant="outline"
                      className="font-mono text-[11px] font-normal"
                    >
                      {value}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Additional values. Removing an addition leaves any matching read-only value active.
            </p>
            <div className="flex gap-2">
              <Input
                value={newValue}
                aria-label="IdP value"
                placeholder="Exact group, role, or ID from the IdP"
                disabled={saving}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addValue();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                disabled={saving || !newValue.trim()}
                onClick={addValue}
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {draftValues.length ? (
                draftValues.map((value) => (
                  <Badge
                    key={value}
                    variant="outline"
                    className="gap-1 bg-muted/50 font-mono text-[11px] font-normal"
                  >
                    {value}
                    <button
                      type="button"
                      aria-label={`Remove ${value}`}
                      className="rounded-sm p-1 hover:bg-muted"
                      disabled={saving}
                      onClick={() =>
                        setDraftValues((current) => current.filter((v) => v !== value))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  No additional values. Saving keeps any read-only values.
                </p>
              )}
            </div>
            {saveError && (
              <p role="alert" className="text-sm text-destructive">
                {saveError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setEditingRoleId(null)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}
