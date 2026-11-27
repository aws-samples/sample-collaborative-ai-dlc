// Project Settings → General → Discovery: whether people who are not members
// can find this space in Browse spaces, and the description they see there.

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Compass } from 'lucide-react';
import { projectsService, type Project } from '@/services/projects';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

export const MAX_DESCRIPTION_LENGTH = 500;

interface Props {
  project: Project;
  canEdit: boolean;
  onProjectUpdated: (updates: Partial<Project>) => void;
}

export function SpaceDiscoveryCard({ project, canEdit, onProjectUpdated }: Props) {
  const [discoverable, setDiscoverable] = useState(project.discoverable ?? false);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState<string | null>(null);

  const discoverableChanged = discoverable !== (project.discoverable ?? false);
  const descriptionChanged = description.trim() !== (project.description ?? '');
  const changed = discoverableChanged || descriptionChanged;

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      // Send only what changed, so a description edit in a stale tab never
      // hides a space another Owner has just made discoverable.
      const saved = await projectsService.update(project.id, {
        ...(discoverableChanged ? { discoverable } : {}),
        ...(descriptionChanged ? { description } : {}),
      });
      const next = {
        discoverable: saved.discoverable ?? project.discoverable ?? false,
        description: saved.description ?? project.description ?? '',
      };
      setDiscoverable(next.discoverable);
      setDescription(next.description);
      onProjectUpdated(next);
      invalidateProjects();
      setResult('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
      setResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <SettingsCard
      icon={<Compass />}
      title="Discovery"
      description="Let people who are not members find this space and ask to join."
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="space-discoverable" className="text-xs">
              Discoverable
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Lists this space in Browse spaces with its name, description and Owners. Its intents,
              workflows and discussions stay members-only. Turning this off cancels pending
              requests.
            </p>
          </div>
          <Switch
            id="space-discoverable"
            checked={discoverable}
            onCheckedChange={setDiscoverable}
            disabled={!canEdit || saving}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="space-description" className="text-xs">
            Description
          </Label>
          <Textarea
            id="space-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DESCRIPTION_LENGTH}
            rows={3}
            placeholder="What this space is for, so people know whether to ask to join."
            disabled={!canEdit || saving}
            className="text-sm disabled:cursor-default"
          />
          <p className="text-[11px] text-muted-foreground">
            {description.length}/{MAX_DESCRIPTION_LENGTH}
          </p>
        </div>
        {canEdit && (
          <SaveStatusButton
            onClick={save}
            disabled={!changed}
            saving={saving}
            label="Save Discovery"
            result={result}
            errorMessage={error}
          />
        )}
      </div>
    </SettingsCard>
  );
}
