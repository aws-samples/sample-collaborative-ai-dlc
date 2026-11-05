// AI-DLC release administration — the platform-admin surface over
// the release registry: register published imports, decide support states and
// visibility, and point the stable/candidate/preview channels. Selection-only:
// nothing here changes what an already-pinned intent runs.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  ChevronRight,
  ChevronDown,
  Search,
  GitFork,
  ListChecks,
  Milestone,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  aidlcReleasesService,
  releaseVersionLabel as releaseLabel,
  isReleaseSelectable,
  type AidlcRelease,
  type RegistrableProfile,
  type ReleaseChannelName,
  type ReleaseChannels,
  type ReleaseSupportState,
} from '@/services/aidlcReleases';
import { ApiError } from '@/services/api';
import { projectsService, type Project } from '@/services/projects';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ReleaseContentsDialog } from '@/components/releases/ReleaseContentsDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const CHANNELS: ReleaseChannelName[] = ['stable', 'candidate', 'preview'];

// Mirrors the backend grammar (lambda/shared/aidlc-custom-source.js): a fork is
// identified by exactly `owner/name` and pinned to a full 40-hex commit SHA,
// because a fork's branches and tags are mutable and third-party controlled.
const CUSTOM_REPOSITORY_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const OFFICIAL_AIDLC_REPOSITORY = 'awslabs/aidlc-workflows';

export const isValidCustomSource = (repository: string, sha: string, baseProfile: string) => {
  const normalizedRepository = repository.trim();
  const repositoryName = normalizedRepository.split('/')[1];
  return (
    CUSTOM_REPOSITORY_RE.test(normalizedRepository) &&
    repositoryName !== '.' &&
    repositoryName !== '..' &&
    !repositoryName.includes('..') &&
    normalizedRepository !== OFFICIAL_AIDLC_REPOSITORY &&
    COMMIT_SHA_RE.test(sha.trim()) &&
    baseProfile !== ''
  );
};

const SUPPORT_STATE_OPTIONS: { value: ReleaseSupportState; label: string }[] = [
  { value: 'importable', label: 'Importable' },
  { value: 'structurally-valid', label: 'Structurally valid' },
  { value: 'selectable', label: 'Selectable' },
  { value: 'certified', label: 'Certified' },
  { value: 'existing-only', label: 'Existing only' },
];

const CONFLICT_MESSAGE =
  'Someone else changed this record at the same time — the list has been refreshed, please retry.';

// Publishing happens outside this UI (the seed lambda writes the immutable
// closure to S3); the copyable command below is the only bridge an operator
// has from "not published" to a registrable profile. Preview with dryRun
// first, then re-run without it.
const publishCommand = (profileId: string) =>
  `aws lambda invoke --function-name <seed-blocks function> --cli-binary-format raw-in-base64-out --payload '{"importRelease":true,"profile":"${profileId}","dryRun":true}' out.json`;

// Upgrading needs the corrected closure published first, at the revision the
// running importer produces — the same seed lambda mode, asserting the revision.
const republishCommand = (profileId: string, importerRevision: number) =>
  `aws lambda invoke --function-name <seed-blocks function> --cli-binary-format raw-in-base64-out --payload '{"importRelease":true,"profile":"${profileId}","importerRevision":${importerRevision}}' out.json`;

const OPERATOR_RUNBOOK_PATH = 'docs/concepts/aidlc-release-compatibility.md';

const PAGE_SIZE = 5;

function unusableReason(release: AidlcRelease) {
  if (release.structurallyValid === false)
    return 'The imported version is invalid. Review technical details before importing a corrected version.';
  // A custom fork becomes runnable through approval; official imports must
  // already be runnable. Keep that distinction aligned with the registry.
  if (!release.runnable && !release.custom)
    return 'This version is import-only and cannot run on this deployment.';
  return null;
}

function versionStatus(release: AidlcRelease, channels: ReleaseChannels | null) {
  if (unusableReason(release)) return 'Not usable';
  if (!release.fidelityEvidenceStale && release.unhonouredValues?.length)
    return 'Compatibility issue';
  if (release.supportState === 'existing-only') return 'Deprecated';
  if (!release.visible && release.supportState === 'certified') return 'Approved · hidden';
  if (isReleaseSelectable(release)) {
    const assigned = CHANNELS.filter(
      (channel) => channels?.[channel]?.releaseId === release.releaseId,
    );
    if (assigned.length)
      return assigned.map((channel) => channel[0].toUpperCase() + channel.slice(1)).join(' · ');
    return release.supportState === 'certified' ? 'Approved' : 'Available to users';
  }
  return 'Needs approval';
}

function sourceMetadata(release: AidlcRelease, profiles: RegistrableProfile[]) {
  const sourceInfo = profiles.find(
    (profile) => profile.profileId === release.profileId,
  )?.sourceInfo;
  const date =
    sourceInfo?.dateKind === 'release' &&
    sourceInfo.date &&
    !Number.isNaN(Date.parse(sourceInfo.date))
      ? sourceInfo.date
      : null;
  const url =
    sourceInfo?.url ??
    (release.sourceRepository &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.sourceRepository) &&
    /^[a-f0-9]{40}$/i.test(release.sourceSha ?? '')
      ? `https://github.com/${release.sourceRepository}/commit/${release.sourceSha}`
      : null);
  return {
    date,
    url,
    title:
      sourceInfo?.dateKind === 'release' ? 'View upstream release' : 'View pinned upstream source',
  };
}

function UpstreamDate({ date }: { date: string }) {
  return (
    <time dateTime={date} title={'Published upstream: ' + date}>
      {new Date(date).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })}
    </time>
  );
}

export function AidlcReleasesTab() {
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const testTrigger = useRef<HTMLButtonElement | null>(null);
  const mutationTrigger = useRef<Element | null>(null);
  const versionDetails = useRef<HTMLDivElement | null>(null);
  const openVersion = (releaseId: string) => {
    setError(null);
    setSelectedReleaseId((current) => (current === releaseId ? null : releaseId));
    let index = matchingReleases.findIndex((release) => release.releaseId === releaseId);
    if (index < 0) {
      setSearch('');
      index = sortedReleases.findIndex((release) => release.releaseId === releaseId);
    }
    setPage(Math.max(0, Math.floor(index / PAGE_SIZE)));
  };

  const [releases, setReleases] = useState<AidlcRelease[]>([]);
  const [testRelease, setTestRelease] = useState<AidlcRelease | null>(null);
  const [contentsReleaseId, setContentsReleaseId] = useState<string | null>(null);
  const [testProjects, setTestProjects] = useState<Project[]>([]);
  const [testProjectsLoading, setTestProjectsLoading] = useState(false);
  const [testProjectsError, setTestProjectsError] = useState<string | null>(null);

  useEffect(() => {
    if (!testRelease) return;
    let cancelled = false;
    setTestProjects([]);
    setTestProjectsLoading(true);
    setTestProjectsError(null);
    projectsService
      .list()
      .then((projects) => {
        if (!cancelled) setTestProjects(projects.filter((project) => project.kind === 'v2'));
      })
      .catch((e) => {
        if (!cancelled)
          setTestProjectsError(e instanceof Error ? e.message : 'Could not load spaces');
      })
      .finally(() => {
        if (!cancelled) setTestProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [testRelease]);
  const [channels, setChannels] = useState<ReleaseChannels | null>(null);
  const [profiles, setProfiles] = useState<RegistrableProfile[]>([]);
  const [currentImporterRevision, setCurrentImporterRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [copiedProfileId, setCopiedProfileId] = useState<string | null>(null);
  const [customRepository, setCustomRepository] = useState('');
  const [customSha, setCustomSha] = useState('');
  const [customBaseProfile, setCustomBaseProfile] = useState('');
  const [pendingClearChannel, setPendingClearChannel] = useState<ReleaseChannelName | null>(null);
  // A closure upgrade changes what every NEW intent on this release runs, so it
  // is confirmed like a channel clear rather than fired on one click.
  const [pendingUpgrade, setPendingUpgrade] = useState<{
    release: AidlcRelease;
    importerRevision: number;
  } | null>(null);

  const refetch = useCallback(async () => {
    const [releasesRes, channelsRes, profilesRes] = await Promise.all([
      aidlcReleasesService.list(),
      aidlcReleasesService.channels(),
      aidlcReleasesService.profiles(),
    ]);
    setReleases(releasesRes.releases);
    setCurrentImporterRevision(releasesRes.currentImporterRevision ?? null);
    setChannels(channelsRes);
    setProfiles(profilesRes.profiles);
    setNoteDrafts({});
  }, []);

  // Initial load and the load-failure Retry share this path. A failed load
  // leaves the registry state unknown, so the render below shows the error
  // alone — never the "No release registered yet" empty states, which would
  // read as an authoritative (and wrong) answer.
  const load = useCallback(() => {
    setLoading(true);
    setLoadFailed(false);
    setError(null);
    return refetch()
      .catch((e) => {
        setLoadFailed(true);
        setError(e instanceof Error ? e.message : 'Failed to load the registry');
      })
      .finally(() => setLoading(false));
  }, [refetch]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (busy || !mutationTrigger.current) return;
    const trigger = mutationTrigger.current;
    mutationTrigger.current = null;
    // Successful approval/channel changes remove their action button. Keep
    // keyboard users at the selected version instead of losing focus to body.
    if (!trigger.isConnected && document.activeElement === document.body)
      versionDetails.current?.focus();
  }, [busy, releases, channels]);

  // Every mutation is CAS-guarded: a 409 means the record moved under us, so
  // surface a clear conflict message and reload the authoritative state.
  // `release_channel_pinned` is the one non-stale 409: the record is a channel
  // target, so retrying is pointless — the channel must move or clear first.
  const runMutation = async (key: string, mutate: () => Promise<void>) => {
    mutationTrigger.current = document.activeElement;
    setBusy(key);
    setError(null);
    try {
      await mutate();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (e.body?.code === 'release_channel_pinned') {
          const pinnedChannel =
            typeof e.body.channel === 'string'
              ? e.body.channel
              : (CHANNELS.find((c) => channels?.[c]?.releaseId === key) ?? 'affected');
          setError(
            `This release is the ${pinnedChannel} channel's target — move or clear the ${pinnedChannel} channel first.`,
          );
        } else {
          setError(CONFLICT_MESSAGE);
          await refetch().catch(() => {});
        }
      } else if (e instanceof ApiError && e.body?.code === 'release_capability_unhandled') {
        const details = e.body.details as
          | { gaps?: { blockType: string; field: string; value: string }[] }
          | undefined;
        const gaps = details?.gaps ?? [];
        const authoredValues = gaps
          .map((gap) => `${gap.blockType}.${gap.field}=${gap.value}`)
          .join(', ');
        setError(
          authoredValues
            ? `This release cannot be promoted because this build cannot honour: ${authoredValues}.`
            : 'This release cannot be promoted because its authored behavior could not be verified.',
        );
      } else {
        setError(e instanceof Error ? e.message : 'Request failed');
      }
    } finally {
      setBusy(null);
    }
  };

  const patchRelease = (
    release: AidlcRelease,
    patch: { supportState?: ReleaseSupportState; visible?: boolean; notes?: string | null },
  ) =>
    runMutation(release.releaseId, async () => {
      const { release: next } = await aidlcReleasesService.update(release.releaseId, {
        expectedRevision: release.revision ?? 0,
        ...patch,
      });
      setReleases((prev) => prev.map((r) => (r.releaseId === next.releaseId ? next : r)));
    });

  const testVersion = (release: AidlcRelease) => {
    if (isReleaseSelectable({ ...release, visible: true })) {
      setTestRelease(release);
      return;
    }
    void runMutation(release.releaseId, async () => {
      // Qualify the closure automatically, without publishing it to users.
      const { release: next } = await aidlcReleasesService.update(release.releaseId, {
        expectedRevision: release.revision ?? 0,
        supportState: 'selectable',
        visible: false,
      });
      setReleases((previous) =>
        previous.map((row) => (row.releaseId === next.releaseId ? next : row)),
      );
      setTestRelease(next);
    });
  };

  // A pointer move, never a rewrite: both closures stay published, intents
  // already pinned to the old one keep running it, and only NEW intents pin the
  // upgraded closure. Same CAS discipline as every other row mutation.
  const upgradeClosure = (release: AidlcRelease, importerRevision: number) =>
    runMutation(release.releaseId, async () => {
      const { release: next } = await aidlcReleasesService.upgradeClosure(release.releaseId, {
        expectedRevision: release.revision ?? 0,
        importerRevision,
      });
      setReleases((prev) => prev.map((r) => (r.releaseId === next.releaseId ? next : r)));
      await refetch();
    });

  const registerProfile = (profile: RegistrableProfile) =>
    runMutation(`register:${profile.profileId}`, async () => {
      await aidlcReleasesService.register(profile.profileId);
      await refetch();
    });

  const registerCustomFork = () =>
    runMutation('register:custom', async () => {
      await aidlcReleasesService.registerCustom({
        repository: customRepository.trim(),
        sha: customSha.trim().toLowerCase(),
        baseProfile: customBaseProfile,
      });
      setCustomRepository('');
      setCustomSha('');
      setCustomBaseProfile('');
      await refetch();
    });

  const setChannelPointer = (channel: ReleaseChannelName, releaseId: string) =>
    runMutation(`channel:${channel}`, async () => {
      const pointer = channels?.[channel] ?? null;
      const { channel: next } = await aidlcReleasesService.setChannel(
        channel,
        releaseId,
        pointer?.revision ?? null,
      );
      setChannels((prev) => (prev ? { ...prev, [channel]: next } : prev));
    });

  // Clearing Stable changes which version new intents use: they return to the
  // configured platform baseline. Existing pins remain unchanged.
  const clearChannelPointer = (channel: ReleaseChannelName) => {
    const pointer = channels?.[channel];
    if (!pointer) return;
    return runMutation(`channel:${channel}`, async () => {
      await aidlcReleasesService.clearChannel(channel, pointer.revision);
      setChannels((prev) => (prev ? { ...prev, [channel]: null } : prev));
    });
  };

  const confirmClearChannel = (channel: ReleaseChannelName) => {
    if (!channels?.[channel]) return;
    setPendingClearChannel(channel);
  };

  const selectedRelease =
    releases.find((release) => release.releaseId === selectedReleaseId) ?? null;
  const sortedReleases = releases.toSorted((left, right) => {
    const leftCustom = left.releaseId.startsWith('aidlc-custom:');
    const rightCustom = right.releaseId.startsWith('aidlc-custom:');
    if (leftCustom !== rightCustom) return leftCustom ? 1 : -1;
    return (
      (right.upstreamVersion ?? '').localeCompare(left.upstreamVersion ?? '', 'en', {
        numeric: true,
      }) || left.releaseId.localeCompare(right.releaseId)
    );
  });
  // Keep an open row in place when its action changes a searched status.
  // Editing the search or changing pages clears the selection.
  const matchingReleases = sortedReleases.filter(
    (release) =>
      release.releaseId === selectedReleaseId ||
      [releaseLabel(release), release.sourceRepository, versionStatus(release, channels)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(matchingReleases.length / PAGE_SIZE) - 1),
  );
  const visibleReleases = matchingReleases.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const offerable = releases.filter(isReleaseSelectable);
  const channelOptions = (channel: ReleaseChannelName) =>
    offerable.filter(
      (release) =>
        !unusableReason(release) &&
        (release.fidelityEvidenceStale || !release.unhonouredValues?.length) &&
        (channel !== 'stable' ||
          release.supportState === 'certified' ||
          profiles.some(
            (profile) => profile.profileId === release.profileId && profile.currentPlatformBaseline,
          )),
    );
  const pinningEnabled = channels?.pinningEnabled;
  const unpublishedProfiles = profiles.filter((profile) => !profile.published);

  const handleCopyPublishCommand = async (profileId: string) => {
    await navigator.clipboard.writeText(publishCommand(profileId));
    setCopiedProfileId(profileId);
    setTimeout(() => setCopiedProfileId(null), 2000);
  };

  const renderVersionDetails = (release: AidlcRelease) => {
    const noteDraft = noteDrafts[release.releaseId];
    const noteDirty = noteDraft !== undefined && noteDraft !== (release.notes ?? '');
    const cannotUse = unusableReason(release);
    const rowBusy = busy !== null;
    const profile = profiles.find((p) => p.profileId === release.profileId) ?? null;
    // Known unpublished only for an allowlisted profile: a fork has no
    // profile row, so its upgrade is attempted and the API decides.
    const upgradePublished = release.custom ? true : (profile?.published ?? false);
    // Evidence the server could not afford to recompute for this
    // listing is a verdict an earlier build reached, so it may name
    // behavior this build now honours. Promotion must stay available:
    // the server re-verifies the closure before it decides, and
    // refuses with a readable reason if the gap is real.
    const evidenceRefreshing = release.fidelityEvidenceStale === true;
    const promotionGaps = evidenceRefreshing ? [] : (release.unhonouredValues ?? []);
    const compatibilityEvidenceMissing = !evidenceRefreshing && release.fidelityGaps === null;
    const assignedChannels = CHANNELS.filter(
      (channel) => channels?.[channel]?.releaseId === release.releaseId,
    );
    const stableAlternatives = channelOptions('stable').filter(
      (option) => option.releaseId !== release.releaseId,
    );

    const canMakeStable =
      isReleaseSelectable(release) &&
      (release.supportState === 'certified' || profile?.currentPlatformBaseline);
    return (
      <div
        ref={versionDetails}
        tabIndex={-1}
        className="space-y-4 py-4 pr-2 sm:pl-4 focus:outline-none"
        role="region"
        aria-label={`Manage AI-DLC ${releaseLabel(release)}`}
      >
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {cannotUse && <p className="text-sm text-muted-foreground">{cannotUse}</p>}
        {promotionGaps.length > 0 && (
          <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
            Compatibility issues prevent use. See Compatibility and contents for the unsupported
            behavior.
          </p>
        )}
        <div className="space-y-3">
          {(release.supportState !== 'certified' || !release.visible) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Button
                size="sm"
                disabled={rowBusy || promotionGaps.length > 0 || !!cannotUse}
                onClick={() =>
                  void patchRelease(release, { supportState: 'certified', visible: true })
                }
              >
                Approve for use
              </Button>
              <p className="text-xs text-muted-foreground">
                Let users choose this version. Compatibility is checked automatically.
              </p>
            </div>
          )}
          {canMakeStable && channels?.stable?.releaseId !== release.releaseId && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Button
                size="sm"
                disabled={
                  rowBusy || pinningEnabled !== true || promotionGaps.length > 0 || !!cannotUse
                }
                onClick={() => void setChannelPointer('stable', release.releaseId)}
              >
                Make stable
              </Button>
              <p className="text-xs text-muted-foreground">
                Use by default for new intents. Existing intents keep their version.
              </p>
            </div>
          )}
          {isReleaseSelectable(release) && channels?.preview?.releaseId !== release.releaseId && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  rowBusy || pinningEnabled !== true || promotionGaps.length > 0 || !!cannotUse
                }
                onClick={() => void setChannelPointer('preview', release.releaseId)}
              >
                Use as preview
              </Button>
              <p className="text-xs text-muted-foreground">
                Offer as an opt-in version, without changing the default.
              </p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button
              ref={testTrigger}
              size="sm"
              variant="outline"
              disabled={
                rowBusy || pinningEnabled !== true || promotionGaps.length > 0 || !!cannotUse
              }
              onClick={() => testVersion(release)}
            >
              Test version
            </Button>
            <p className="text-xs text-muted-foreground">
              Optional: try a new intent in a space you choose.
            </p>
          </div>
        </div>
        {channels?.stable?.releaseId === release.releaseId && (
          <p role="status" className="text-xs text-muted-foreground">
            This is the default for new intents. Existing intents keep their version.
          </p>
        )}
        {!canMakeStable && !cannotUse && release.supportState !== 'certified' && (
          <p className="text-xs text-muted-foreground">Approval also enables Make stable.</p>
        )}
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-xs font-medium">
            Compatibility and contents
          </summary>
          <div className="mt-3 space-y-3 text-xs text-muted-foreground">
            <p>
              In Collaborative, repositories are fixed when an intent starts. To add a repository,
              start a new intent.
            </p>
            {promotionGaps.length > 0 && (
              <p
                className="text-[11px] text-amber-600 dark:text-amber-400"
                data-testid={`release-promotion-gaps-${release.releaseId}`}
              >
                Cannot promote: this build cannot honour{' '}
                {promotionGaps
                  .map((gap) => `${gap.blockType}.${gap.field}=${gap.value}`)
                  .join(', ')}
                .
              </p>
            )}
            {evidenceRefreshing && (
              <p
                className="text-[11px] text-muted-foreground"
                data-testid={`release-evidence-refreshing-${release.releaseId}`}
              >
                Capability evidence is being refreshed for this record; the server verifies its
                immutable closure before promotion.
              </p>
            )}
            {compatibilityEvidenceMissing && (
              <p
                className="text-[11px] text-muted-foreground"
                data-testid={`release-promotion-unverified-${release.releaseId}`}
              >
                Capability evidence is not cached for this legacy record; the server will verify its
                immutable closure before promotion.
              </p>
            )}

            {release.notes && (
              <p>
                <span className="font-medium text-foreground">Admin notes: </span>
                {release.notes}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setContentsReleaseId(release.releaseId)}
              >
                Browse contents
              </Button>
              <p>Inspect this version’s workflow, stages, agents and prompts.</p>
            </div>
          </div>
        </details>
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-xs font-medium">Maintenance</summary>
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Change availability for new intents. Existing intents keep their version.
            </p>
            {assignedChannels.includes('stable') && (
              <div className="space-y-2">
                <label className="block text-xs font-medium" htmlFor="replacement-stable">
                  Replace stable with
                </label>
                <Select
                  value=""
                  disabled={rowBusy || stableAlternatives.length === 0 || pinningEnabled !== true}
                  onValueChange={(value) => void setChannelPointer('stable', value)}
                >
                  <SelectTrigger
                    id="replacement-stable"
                    aria-label="Replace stable with"
                    className="h-8 w-full sm:w-72"
                  >
                    <SelectValue placeholder="Choose another approved version…" />
                  </SelectTrigger>
                  <SelectContent>
                    {stableAlternatives.map((option) => (
                      <SelectItem key={option.releaseId} value={option.releaseId}>
                        {releaseLabel(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {stableAlternatives.length
                    ? 'Switch the default to an older or newer approved version.'
                    : 'Approve another version first so new intents keep a working default.'}
                </p>
              </div>
            )}
            {assignedChannels
              .filter((channel) => channel !== 'stable')
              .map((channel) => (
                <div key={channel} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rowBusy}
                    onClick={() => void clearChannelPointer(channel)}
                  >
                    Remove from {channel}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Remove this channel choice for new intents. The version stays available by name.
                  </p>
                </div>
              ))}
            {release.supportState !== 'existing-only' && (
              <div className="space-y-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rowBusy || assignedChannels.length > 0}
                  onClick={() =>
                    void patchRelease(release, { supportState: 'existing-only', visible: false })
                  }
                >
                  Deprecate version
                </Button>
                <p className="text-xs text-muted-foreground">
                  {assignedChannels.length
                    ? 'Replace or remove its channel assignments above before deprecating.'
                    : 'Stop offering it for new intents. Existing intents continue; you can approve it again later.'}
                </p>
              </div>
            )}
            <details className="border-t pt-3">
              <summary className="cursor-pointer text-xs font-medium">
                Import details and advanced state
              </summary>
              <div className="mt-3 space-y-3">
                <p className="font-mono text-[11px] text-muted-foreground break-all">
                  {release.releaseId}
                  {release.closureDigest ? ` · closure ${release.closureDigest.slice(0, 12)}…` : ''}
                </p>
                {release.importerStale && currentImporterRevision !== null && (
                  <div
                    className="flex flex-wrap items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400"
                    data-testid={`release-stale-${release.releaseId}`}
                  >
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      This closure was imported by importer revision {release.importerRevision}; the
                      platform now imports revision {currentImporterRevision}. New intents created
                      on it miss methodology fields newer mappers read. Upgrading only changes what
                      NEW intents pin — existing intents keep their closure.
                      {!upgradePublished && (
                        <>
                          {' '}
                          Publish the revision {currentImporterRevision} closure first:
                          <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
                            {republishCommand(release.profileId, currentImporterRevision)}
                          </code>
                        </>
                      )}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 gap-1.5 text-xs"
                      disabled={rowBusy || !upgradePublished}
                      onClick={() =>
                        setPendingUpgrade({
                          release,
                          importerRevision: currentImporterRevision,
                        })
                      }
                      aria-label={`Upgrade closure for ${releaseLabel(release)}`}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Upgrade closure
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Support state</span>
                    <Select
                      value={release.supportState}
                      onValueChange={(v) =>
                        patchRelease(release, { supportState: v as ReleaseSupportState })
                      }
                      disabled={rowBusy}
                    >
                      <SelectTrigger
                        className="h-8 w-44"
                        aria-label={`Support state for ${releaseLabel(release)}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORT_STATE_OPTIONS.map((option) => (
                          <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={
                              (promotionGaps.length > 0 || !!cannotUse) &&
                              ['selectable', 'certified'].includes(option.value) &&
                              option.value !== release.supportState
                            }
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    Visible to users
                    <Switch
                      checked={release.visible}
                      onCheckedChange={(checked) => patchRelease(release, { visible: checked })}
                      disabled={
                        rowBusy ||
                        (!release.visible &&
                          promotionGaps.length > 0 &&
                          ['selectable', 'certified'].includes(release.supportState))
                      }
                      aria-label={`Visibility for ${releaseLabel(release)}`}
                    />
                  </label>
                </div>
              </div>
            </details>
            <div className="flex items-center gap-2">
              <Input
                value={noteDraft ?? release.notes ?? ''}
                onChange={(e) =>
                  setNoteDrafts((prev) => ({
                    ...prev,
                    [release.releaseId]: e.target.value,
                  }))
                }
                placeholder="Notes (e.g. certification evidence, known issues)"
                className="h-8 text-xs"
                aria-label={`Notes for ${releaseLabel(release)}`}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                disabled={!noteDirty || rowBusy}
                onClick={() => patchRelease(release, { notes: noteDraft || null })}
              >
                Save notes
              </Button>
            </div>
          </div>
        </details>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6" data-testid="aidlc-releases-skeleton">
        <div className="grid gap-3 sm:grid-cols-3">
          {CHANNELS.map((channel) => (
            <Skeleton key={channel} className="h-24 w-full rounded-md" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="space-y-3">
        <div
          className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error ?? 'Failed to load the registry'}
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && !selectedRelease && (
        <div
          className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

      {pinningEnabled !== true && (
        <div
          role="status"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
        >
          {pinningEnabled === false
            ? 'Version selection is disabled for this deployment. Enable AI-DLC release pinning before testing or using a version. Existing pinned intents are unchanged.'
            : 'Version selection availability could not be confirmed. Refresh before testing or using a version.'}
        </div>
      )}
      <section aria-label="Supported versions" className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Supported versions</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Stable is the default for new intents. Existing intents keep their version.
          </p>
        </div>
        <div
          className="flex flex-wrap gap-x-6 gap-y-2 text-sm"
          aria-label="Current version channels"
        >
          {(['stable', 'preview', 'candidate'] as const)
            .filter((channel) => channel !== 'candidate' || channels?.candidate)
            .map((channel) => {
              const pointer = channels?.[channel];
              const version = releases.find((release) => release.releaseId === pointer?.releaseId);
              return (
                <div key={channel} className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {channel === 'stable'
                      ? 'Stable (default)'
                      : channel === 'preview'
                        ? 'Preview'
                        : 'Candidate'}
                    :
                  </span>
                  {version ? (
                    <button
                      type="button"
                      onClick={() => openVersion(version.releaseId)}
                      className="font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Manage ${channel} version ${releaseLabel(version)}`}
                    >
                      {releaseLabel(version)}
                    </button>
                  ) : (
                    <span>
                      {pointer
                        ? 'Unavailable'
                        : channel === 'stable'
                          ? 'Platform default'
                          : 'Not set'}
                    </span>
                  )}
                </div>
              );
            })}
        </div>
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions have been added yet. Open Add version below.
          </p>
        ) : (
          <>
            <div className="relative max-w-sm">
              <Search
                aria-hidden="true"
                className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground"
              />
              <Input
                aria-label="Search versions"
                placeholder="Search version, status or repository…"
                value={search}
                onChange={(event) => {
                  setSelectedReleaseId(null);
                  setSearch(event.target.value);
                  setPage(0);
                }}
                className="h-9 pl-9 pr-9"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setSelectedReleaseId(null);
                    setSearch('');
                    setPage(0);
                  }}
                  className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <table className="w-full text-left text-sm" aria-label="AI-DLC versions">
              <thead className="border-b text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Version
                  </th>
                  <th scope="col" className="hidden pb-2 font-medium sm:table-cell">
                    Upstream release
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Status
                  </th>
                  <th scope="col">
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibleReleases.map((release) => {
                  const source = sourceMetadata(release, profiles);
                  const status = versionStatus(release, channels);
                  return (
                    <Fragment key={release.releaseId}>
                      <tr
                        data-testid={`release-row-${release.releaseId}`}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest('button, a')) return;
                          openVersion(release.releaseId);
                        }}
                        className={
                          selectedReleaseId === release.releaseId
                            ? 'cursor-pointer bg-muted/40'
                            : 'group cursor-pointer hover:bg-muted/40'
                        }
                      >
                        <td className="py-2 pr-2">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label={`Manage version ${releaseLabel(release)}`}
                              aria-expanded={selectedReleaseId === release.releaseId}
                              onClick={() => openVersion(release.releaseId)}
                              className="min-h-8 break-all text-left font-mono font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {releaseLabel(release)}
                            </button>
                            {source.url && (
                              <a
                                href={source.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={source.title}
                                aria-label={`${source.title} for ${releaseLabel(release)}`}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                              </a>
                            )}
                          </div>
                          {source.date && (
                            <span className="block text-[11px] text-muted-foreground sm:hidden">
                              <UpstreamDate date={source.date} />
                            </span>
                          )}
                        </td>
                        <td className="hidden py-2 pr-2 text-xs text-muted-foreground sm:table-cell">
                          {source.date ? (
                            <UpstreamDate date={source.date} />
                          ) : (
                            <span aria-label="No upstream release date">—</span>
                          )}
                        </td>
                        <td
                          className={`py-2 text-xs ${status.includes('Stable') ? 'font-semibold' : status === 'Compatibility issue' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                        >
                          {status}
                        </td>
                        <td className="w-9 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`Open details for ${releaseLabel(release)}`}
                            aria-expanded={selectedReleaseId === release.releaseId}
                            onClick={() => openVersion(release.releaseId)}
                          >
                            {selectedReleaseId === release.releaseId ? (
                              <ChevronDown aria-hidden="true" className="h-4 w-4" />
                            ) : (
                              <ChevronRight aria-hidden="true" className="h-4 w-4" />
                            )}
                          </Button>
                        </td>
                      </tr>
                      {selectedReleaseId === release.releaseId && (
                        <tr>
                          <td colSpan={4}>{renderVersionDetails(release)}</td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {matchingReleases.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No versions match “{search}”. Try another version, status or repository.
              </p>
            )}
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span role="status">
                {matchingReleases.length
                  ? `${currentPage * PAGE_SIZE + 1}–${Math.min((currentPage + 1) * PAGE_SIZE, matchingReleases.length)} of ${matchingReleases.length} versions`
                  : '0 versions'}
              </span>
              {matchingReleases.length > PAGE_SIZE && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={currentPage === 0}
                    onClick={() => {
                      setSelectedReleaseId(null);
                      setPage(currentPage - 1);
                    }}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={(currentPage + 1) * PAGE_SIZE >= matchingReleases.length}
                    onClick={() => {
                      setSelectedReleaseId(null);
                      setPage(currentPage + 1);
                    }}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </section>

      <details className="border-t">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Manage release channels
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Clear assignments or manage Candidate
          </span>
        </summary>
        <div className="px-4 pb-4">
          <SettingsCard
            icon={<Milestone />}
            title="Release channels"
            description="Named pointers new intents can follow — the stable channel is the default pin for every new intent."
          >
            {pinningEnabled === false && (
              <div className="mb-3 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Per-intent release selection is currently disabled (
                  <code className="font-mono">AIDLC_RELEASE_PINNING</code> is off). New intents
                  ignore these channels and use the platform baseline; already-pinned intents keep
                  their release.
                </span>
              </div>
            )}
            {pinningEnabled === true && (
              <p className="mb-3 text-[11px] text-muted-foreground">
                Per-intent release selection is enabled (
                <code className="font-mono">AIDLC_RELEASE_PINNING</code>).
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {CHANNELS.map((channel) => {
                const options = channelOptions(channel);
                const pointer = channels?.[channel] ?? null;
                const pointed = pointer
                  ? (releases.find((r) => r.releaseId === pointer.releaseId) ?? null)
                  : null;
                // A stale pointer names a release that no longer exists or is no
                // longer selectable — new intents can't follow it, so it must be
                // moved or cleared.
                const stale = pointer !== null && (!pointed || !isReleaseSelectable(pointed));
                return (
                  <div key={channel} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold capitalize">{channel}</span>
                      <span className="flex items-center gap-1">
                        {pointer ? (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {pointed ? releaseLabel(pointed) : pointer.releaseId}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            unset
                          </Badge>
                        )}
                        {pointer && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0"
                            disabled={busy === `channel:${channel}`}
                            onClick={() => confirmClearChannel(channel)}
                            aria-label={`Clear ${channel} channel`}
                            title={`Clear ${channel} channel`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </span>
                    </div>
                    {stale && (
                      <p className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                        <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          Stale pointer — its target is no longer selectable, so new intents cannot
                          follow this channel. Point it at another release or clear it.
                        </span>
                      </p>
                    )}
                    <Select
                      value={pointer?.releaseId ?? ''}
                      onValueChange={(v) => setChannelPointer(channel, v)}
                      disabled={busy !== null || options.length === 0}
                    >
                      <SelectTrigger className="h-8" aria-label={`${channel} channel release`}>
                        <SelectValue
                          placeholder={options.length === 0 ? 'No eligible version' : 'Pick…'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((release) => (
                          <SelectItem key={release.releaseId} value={release.releaseId}>
                            {releaseLabel(release)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Only visible, runnable releases in a selectable or certified state can hold a channel;
              the stable channel additionally requires certification (except the current platform
              baseline). Moving a pointer never touches existing intents.
            </p>
          </SettingsCard>
        </div>
      </details>

      <details className="border-t">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Add version{' '}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Choose a supported version or a custom source
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <SettingsCard
            icon={<ListChecks />}
            title="Supported versions to add"
            description="Upstream AI-DLC versions the importer may bring in — register a published one to create its registry record."
          >
            {profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No allowlisted profile.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {profiles.map((profile) => (
                  <div
                    key={profile.profileId}
                    className="flex flex-wrap items-center gap-2 px-3 py-2.5"
                    data-testid={`profile-row-${profile.profileId}`}
                  >
                    <span className="font-mono text-sm">
                      {profile.upstreamVersion || profile.upstreamRef.slice(0, 7)}
                    </span>
                    {profile.upstreamChannel && (
                      <Badge variant="outline" className="text-[10px]">
                        {profile.upstreamChannel}
                      </Badge>
                    )}
                    {profile.trustTier && (
                      <Badge variant="outline" className="text-[10px]">
                        {profile.trustTier}
                      </Badge>
                    )}
                    {profile.currentPlatformBaseline && (
                      <Badge variant="secondary" className="text-[10px]">
                        platform baseline
                      </Badge>
                    )}
                    {!profile.runnable && (
                      <Badge variant="destructive" className="text-[10px]">
                        import-only, not runnable
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground">
                      {profile.published ? 'published' : 'not published'}
                      {' · '}
                      {profile.registered
                        ? `registered (${profile.supportState})`
                        : 'not registered'}
                      {profile.importerStale ? ' · registered closure is stale' : ''}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {!profile.published && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 gap-1.5 text-xs"
                          onClick={() => void handleCopyPublishCommand(profile.profileId)}
                          aria-label={`Copy publish command for ${profile.profileId}`}
                        >
                          {copiedProfileId === profile.profileId ? (
                            <Check className="h-3 w-3 text-agent-success" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          Copy publish command
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7"
                        disabled={
                          !profile.published ||
                          profile.registered ||
                          busy === `register:${profile.profileId}`
                        }
                        onClick={() => registerProfile(profile)}
                      >
                        {profile.registered ? 'Registered' : 'Register'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {unpublishedProfiles.length > 0 && (
              <div className="mt-3 space-y-2 rounded-md border bg-muted/20 px-3 py-2.5">
                <p className="text-xs font-medium">How a profile becomes published</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Publishing happens outside this page: the seed lambda&apos;s
                  <span className="font-mono"> importRelease </span>
                  mode fetches the pinned upstream commit and writes its immutable closure to S3.
                  Preview with <span className="font-mono">dryRun</span> first, then re-run without
                  it:
                </p>
                <code className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                  {publishCommand(unpublishedProfiles[0].profileId)}
                </code>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Full sequence and verification commands: see the operator runbook in
                  <span className="font-mono"> {OPERATOR_RUNBOOK_PATH}</span>.
                </p>
              </div>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              Registration records import evidence; it does not make a release offerable. Promote it
              via its support state above once reviewed.
            </p>
          </SettingsCard>

          <SettingsCard
            icon={<GitFork />}
            title="Register custom fork"
            description="Import a fork of aidlc-workflows. It stays import-only until an admin promotes it."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Repository</span>
                <Input
                  value={customRepository}
                  onChange={(e) => setCustomRepository(e.target.value)}
                  placeholder="owner/name"
                  className="h-8 font-mono text-xs"
                  aria-label="Custom fork repository"
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Commit SHA</span>
                <Input
                  value={customSha}
                  onChange={(e) => setCustomSha(e.target.value)}
                  placeholder="40-hex commit SHA"
                  className="h-8 font-mono text-xs"
                  aria-label="Custom fork commit SHA"
                />
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Base dialect</span>
                <Select value={customBaseProfile} onValueChange={setCustomBaseProfile}>
                  <SelectTrigger className="h-8" aria-label="Custom fork base dialect">
                    <SelectValue placeholder={profiles.length === 0 ? 'No profile' : 'Pick…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((option) => (
                      <SelectItem key={option.profileId} value={option.profileId}>
                        {option.upstreamVersion || option.profileId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8"
                disabled={
                  busy === 'register:custom' ||
                  !isValidCustomSource(customRepository, customSha, customBaseProfile)
                }
                onClick={registerCustomFork}
              >
                Register fork
              </Button>
              <p className="text-[11px] text-muted-foreground">
                The fork&apos;s closure must already be published by the seed lambda&apos;s
                <span className="font-mono"> importRelease </span>
                custom mode. The base dialect only says how the fork&apos;s frontmatter is parsed —
                it grants no trust. The record is recorded T0 and import-only. Promoting it to
                selectable or certified runs the same guard as an official release: it is refused
                while the fork authors behavior this build cannot honour, and the record lists those
                gaps. Once promoted, the fork is offered to every project, and its sensor scripts
                and their commands run in the agent runtime with the runtime&apos;s own permissions.
                Promote only a fork whose sources you would run as your own sensors.
              </p>
            </div>
          </SettingsCard>
        </div>
      </details>

      {contentsReleaseId && (
        <ReleaseContentsDialog
          releaseId={contentsReleaseId}
          onClose={() => setContentsReleaseId(null)}
        />
      )}
      <Dialog
        open={testRelease !== null}
        onOpenChange={(open) => {
          if (!open) setTestRelease(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            testTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Test AI-DLC {testRelease ? releaseLabel(testRelease) : ''}</DialogTitle>
            <DialogDescription>
              Choose a space for the test. It uses that space’s normal runtime and model budget, and
              is shared with its members. Only an admin can start it.
            </DialogDescription>
          </DialogHeader>
          {testProjectsLoading && <p role="status">Loading spaces…</p>}
          {testProjectsError && <p role="alert">{testProjectsError}</p>}
          {!testProjectsLoading && !testProjectsError && testProjects.length === 0 && (
            <p>No accessible v2 spaces. Create a space before testing a version.</p>
          )}
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {testRelease &&
              testProjects.map((project) => (
                <Button key={project.id} asChild variant="outline" className="w-full justify-start">
                  <a
                    href={`/space/${encodeURIComponent(project.id)}/intent/new?release=${encodeURIComponent(testRelease!.releaseId)}&testRelease=1`}
                  >
                    {project.name}
                  </a>
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={pendingUpgrade !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUpgrade(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Upgrade the closure for{' '}
              {pendingUpgrade ? releaseLabel(pendingUpgrade.release) : 'this release'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Only new intents change: they will pin the closure published at importer revision{' '}
              {pendingUpgrade?.importerRevision}. Intents already pinned to this release keep the
              closure they started with.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingUpgrade;
                setPendingUpgrade(null);
                if (target) void upgradeClosure(target.release, target.importerRevision);
              }}
            >
              Upgrade closure
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingClearChannel !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClearChannel(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the {pendingClearChannel} channel?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingClearChannel === 'stable'
                ? 'New intents will return to the configured platform baseline until another Stable version is chosen. Existing intents keep their version.'
                : `New intents will no longer be able to follow the ${pendingClearChannel} channel until it is pointed at a release again.`}{' '}
              Already-pinned intents keep their release.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const channel = pendingClearChannel;
                setPendingClearChannel(null);
                if (channel) void clearChannelPointer(channel);
              }}
            >
              Clear channel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
