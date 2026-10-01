// AI-DLC release administration — the platform-admin surface over
// the release registry: register published imports, decide support states and
// visibility, and point the stable/candidate/preview channels. Selection-only:
// nothing here changes what an already-pinned intent runs.

import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Copy,
  GitCommitVertical,
  GitFork,
  ListChecks,
  Milestone,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  aidlcReleasesService,
  isReleaseSelectable,
  type AidlcRelease,
  type RegistrableProfile,
  type ReleaseChannelName,
  type ReleaseChannels,
  type ReleaseSupportState,
} from '@/services/aidlcReleases';
import { ApiError } from '@/services/api';
import { SettingsCard } from '@/components/settings/SettingsCard';
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

const releaseLabel = (release: AidlcRelease) =>
  release.upstreamVersion || release.sourceSha?.slice(0, 7) || release.releaseId;

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

export function AidlcReleasesTab() {
  const [releases, setReleases] = useState<AidlcRelease[]>([]);
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

  // Every mutation is CAS-guarded: a 409 means the record moved under us, so
  // surface a clear conflict message and reload the authoritative state.
  // `release_channel_pinned` is the one non-stale 409: the record is a channel
  // target, so retrying is pointless — the channel must move or clear first.
  const runMutation = async (key: string, mutate: () => Promise<void>) => {
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

  // Clearing a channel is not a display toggle: `stable` is the default pin for
  // every NEW intent, so an unset pointer stops intent creation from resolving a
  // release at all. It is one irreversible click behind an X icon, hence the
  // confirmation.
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

  const offerable = releases.filter(isReleaseSelectable);
  const pinningEnabled = channels?.pinningEnabled;
  const unpublishedProfiles = profiles.filter((profile) => !profile.published);

  const handleCopyPublishCommand = async (profileId: string) => {
    await navigator.clipboard.writeText(publishCommand(profileId));
    setCopiedProfileId(profileId);
    setTimeout(() => setCopiedProfileId(null), 2000);
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
      {error && (
        <div
          className="rounded border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      )}

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
              <code className="font-mono">AIDLC_RELEASE_PINNING</code> is off). New intents ignore
              these channels and use the platform baseline; already-pinned intents keep their
              release.
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
                  disabled={busy === `channel:${channel}` || offerable.length === 0}
                >
                  <SelectTrigger className="h-8" aria-label={`${channel} channel release`}>
                    <SelectValue
                      placeholder={offerable.length === 0 ? 'No offerable release' : 'Pick…'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {offerable.map((release) => (
                      <SelectItem key={release.releaseId} value={release.releaseId}>
                        {releaseLabel(release)} ({release.supportState})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Only visible, runnable releases in a selectable or certified state can hold a channel; the
          stable channel additionally requires certification (except the current platform baseline).
          Moving a pointer never touches existing intents.
        </p>
      </SettingsCard>

      <SettingsCard
        icon={<GitCommitVertical />}
        title="Registered releases"
        description="Every imported AI-DLC release and its support decision — what NEW intents may pin."
      >
        {releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No release registered yet — register a published profile below.
          </p>
        ) : (
          <div className="space-y-3">
            {releases.map((release) => {
              const noteDraft = noteDrafts[release.releaseId];
              const noteDirty = noteDraft !== undefined && noteDraft !== (release.notes ?? '');
              const rowBusy = busy === release.releaseId;
              const profile = profiles.find((p) => p.profileId === release.profileId) ?? null;
              // Known unpublished only for an allowlisted profile: a fork has no
              // profile row, so its upgrade is attempted and the API decides.
              const upgradePublished = release.custom ? true : (profile?.published ?? false);
              const promotionGaps = release.unhonouredValues ?? [];
              const compatibilityEvidenceMissing = release.fidelityGaps === null;
              return (
                <div
                  key={release.releaseId}
                  className="rounded-md border p-3 space-y-3"
                  data-testid={`release-row-${release.releaseId}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold">{releaseLabel(release)}</span>
                    {release.upstreamChannel && (
                      <Badge variant="outline" className="text-[10px]">
                        {release.upstreamChannel}
                      </Badge>
                    )}
                    {release.trustTier && (
                      <Badge variant="outline" className="text-[10px]">
                        {release.trustTier}
                      </Badge>
                    )}
                    {release.custom && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        custom fork {release.sourceRepository ?? ''}
                      </Badge>
                    )}
                    {release.runnable ? (
                      <Badge variant="secondary" className="text-[10px]">
                        runnable
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">
                        import-only, not runnable
                      </Badge>
                    )}
                    {release.structurallyValid === false && (
                      <Badge variant="destructive" className="text-[10px]">
                        not structurally valid
                      </Badge>
                    )}
                    {release.importerStale && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400"
                      >
                        stale closure (importer i{release.importerRevision})
                      </Badge>
                    )}
                    {release.supportState === 'certified' && release.certifiedAt && (
                      <span className="text-[11px] text-muted-foreground">
                        certified {new Date(release.certifiedAt).toLocaleDateString()}
                        {release.certifiedBy ? ` by ${release.certifiedBy}` : ''}
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground break-all">
                    {release.releaseId}
                    {release.closureDigest
                      ? ` · closure ${release.closureDigest.slice(0, 12)}…`
                      : ''}
                  </p>
                  {release.importerStale && currentImporterRevision !== null && (
                    <div
                      className="flex flex-wrap items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-600 dark:text-amber-400"
                      data-testid={`release-stale-${release.releaseId}`}
                    >
                      <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        This closure was imported by importer revision {release.importerRevision};
                        the platform now imports revision {currentImporterRevision}. New intents
                        created on it miss methodology fields newer mappers read. Upgrading only
                        changes what NEW intents pin — existing intents keep their closure.
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
                          setPendingUpgrade({ release, importerRevision: currentImporterRevision })
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
                                promotionGaps.length > 0 &&
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
                  {compatibilityEvidenceMissing && (
                    <p
                      className="text-[11px] text-muted-foreground"
                      data-testid={`release-promotion-unverified-${release.releaseId}`}
                    >
                      Capability evidence is not cached for this legacy record; the server will
                      verify its immutable closure before promotion.
                    </p>
                  )}
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
              );
            })}
            <p className="text-[11px] text-muted-foreground">
              Importable / structurally valid = import evidence only; selectable / certified = may
              be pinned by new intents (visible + runnable required); existing only = withdrawn from
              new intents while pinned intents keep running it. Runnability is decided at
              registration and never changes.
            </p>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        icon={<ListChecks />}
        title="Allowlisted profiles"
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
                  {profile.registered ? `registered (${profile.supportState})` : 'not registered'}
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
              Preview with <span className="font-mono">dryRun</span> first, then re-run without it:
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
          Registration records import evidence; it does not make a release offerable. Promote it via
          its support state above once reviewed.
        </p>
      </SettingsCard>

      <SettingsCard
        icon={<GitFork />}
        title="Register custom fork"
        description="Import a fork of aidlc-workflows for inspection. Custom forks are import-only and can never be selected or run."
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
            custom mode. The base dialect only says how the fork&apos;s frontmatter is parsed — it
            grants no trust. The record is recorded T0, stays import-only, and is never offered to a
            new intent until sandboxed execution and IAM isolation exist.
          </p>
        </div>
      </SettingsCard>

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
                ? 'The stable channel is the default pin for every new intent. With no pointer, new intents cannot resolve a release and intent creation will fail until it is set again.'
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
