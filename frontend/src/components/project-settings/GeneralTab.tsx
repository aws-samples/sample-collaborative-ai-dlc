// Project Settings → General tab: project name + v2 runtime knobs.
// Self-contained: owns its form state and saves; the page only provides the
// project and a callback to sync the updated fields upward.

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Settings2, SlidersHorizontal } from 'lucide-react';
import { projectsService, type Project, type PrStrategy } from '@/services/projects';
import { invalidateProjects } from '@/hooks/useProjectsCache';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

interface Props {
  project: Project;
  canEdit: boolean;
  onProjectUpdated: (updates: Partial<Project>) => void;
}

export function GeneralTab({ project, canEdit, onProjectUpdated }: Props) {
  // --- Name -----------------------------------------------------------------
  const [editName, setEditName] = useState(project.name);
  const [savingName, setSavingName] = useState(false);
  const [nameResult, setNameResult] = useState<SaveResult>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const saveName = async () => {
    if (editName === project.name || !editName.trim()) return;
    setSavingName(true);
    setNameResult(null);
    try {
      await projectsService.update(project.id, { name: editName });
      onProjectUpdated({ name: editName });
      invalidateProjects();
      setNameResult('saved');
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Failed to save');
      setNameResult('error');
    } finally {
      setSavingName(false);
      setTimeout(() => setNameResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  // --- v2 runtime settings ----------------------------------------------------
  const [parkReleaseSeconds, setParkReleaseSeconds] = useState(project.parkReleaseSeconds ?? 300);
  const [maxParallelUnits, setMaxParallelUnits] = useState(project.maxParallelUnits ?? 0);
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [runtimeResult, setRuntimeResult] = useState<SaveResult>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const runtimeChanged =
    parkReleaseSeconds !== (project.parkReleaseSeconds ?? 300) ||
    maxParallelUnits !== (project.maxParallelUnits ?? 0);

  const saveRuntime = async () => {
    setSavingRuntime(true);
    setRuntimeResult(null);
    try {
      const prStrategy: PrStrategy = project.prStrategy ?? 'intent-pr';
      const saved = await projectsService.update(project.id, {
        parkReleaseSeconds,
        maxParallelUnits,
        prStrategy,
      });
      const next = saved.parkReleaseSeconds ?? parkReleaseSeconds;
      const nextParallel = saved.maxParallelUnits ?? maxParallelUnits;
      setParkReleaseSeconds(next);
      setMaxParallelUnits(nextParallel);
      onProjectUpdated({
        parkReleaseSeconds: next,
        maxParallelUnits: nextParallel,
        prStrategy: saved.prStrategy ?? prStrategy,
      });
      setRuntimeResult('saved');
    } catch (err) {
      setRuntimeError(err instanceof Error ? err.message : 'Failed to save');
      setRuntimeResult('error');
    } finally {
      setSavingRuntime(false);
      setTimeout(() => setRuntimeResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsCard icon={<Settings2 />} title="General" description="Basic project information.">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="proj-name" className="text-xs">
              Project Name
            </Label>
            <Input
              id="proj-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              disabled={!canEdit || savingName}
              className="text-sm h-9"
              required
            />
          </div>
          {canEdit && (
            <SaveStatusButton
              onClick={saveName}
              disabled={editName === project.name || !editName.trim()}
              saving={savingName}
              label="Save Changes"
              result={nameResult}
              errorMessage={nameError}
            />
          )}
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<SlidersHorizontal />}
        title="Runtime"
        badge={
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] font-medium leading-4 text-muted-foreground">
            {project.workflowId ?? 'aidlc-v2'}
          </span>
        }
        description="Execution knobs for this project — the workflow is pinned at creation; scope is chosen per-intent."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="park-release" className="text-xs">
                Park release (seconds)
              </Label>
              <Input
                id="park-release"
                type="number"
                min={0}
                max={900}
                value={parkReleaseSeconds}
                onChange={(e) => setParkReleaseSeconds(Number(e.target.value))}
                className="font-mono text-sm h-9"
                disabled={!canEdit || savingRuntime}
              />
              <p className="text-[11px] text-muted-foreground">
                How long a stage waiting for a human keeps its compute before release (0–900).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="max-parallel-units" className="text-xs">
                Max parallel units
              </Label>
              <Input
                id="max-parallel-units"
                type="number"
                min={0}
                max={64}
                value={maxParallelUnits}
                onChange={(e) => setMaxParallelUnits(Number(e.target.value))}
                className="font-mono text-sm h-9"
                disabled={!canEdit || savingRuntime}
              />
              <p className="text-[11px] text-muted-foreground">
                Concurrent unit-of-work lanes during construction (0 = unbounded).
              </p>
            </div>
          </div>
          {canEdit ? (
            <SaveStatusButton
              onClick={saveRuntime}
              disabled={!runtimeChanged}
              saving={savingRuntime}
              label="Save Runtime"
              result={runtimeResult}
              errorMessage={runtimeError}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Only owners and admins can change runtime settings.
            </p>
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
