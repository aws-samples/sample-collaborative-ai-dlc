import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Boxes, Plus, RotateCw, Search, TriangleAlert } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SettingsCard } from '@/components/settings/SettingsCard';
import {
  environmentsService,
  toolsService,
  type EnvironmentDetail,
  type EnvironmentRevision,
  type ManagedEnvironment,
  type ManagedTool,
} from '@/services/environments';
import { cn } from '@/lib/utils';
import { EnvironmentBuilder } from './environment-builder/EnvironmentBuilder';
import {
  EnvironmentRevisionWorkspace,
  isActiveRevision,
} from './environment-builder/EnvironmentRevisionWorkspace';
import {
  emptyEnvironmentForm,
  formFingerprint,
  formFromRevision,
  isCatalogRecipe,
  recipeFromForm,
  type EnvironmentForm,
} from './environment-builder/model';
import { StatusBadge, statusClass } from './environment-builder/ui';

type Workspace = 'definition' | 'revisions';
type EnvironmentFilter = 'all' | 'attention' | 'drafts' | 'published' | 'retired';

interface Confirmation {
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}

const filterEnvironment = (environment: ManagedEnvironment, filter: EnvironmentFilter) => {
  if (filter === 'all') return true;
  if (filter === 'attention') {
    return (
      environment.updateAvailable ||
      environment.status === 'FAILED' ||
      environment.status === 'SECURITY_REVIEW'
    );
  }
  if (filter === 'drafts') {
    return ['DRAFT', 'BUILDING', 'SECURITY_REVIEW', 'VERIFYING', 'READY', 'FAILED'].includes(
      environment.status,
    );
  }
  if (filter === 'published') return environment.status === 'PUBLISHED';
  return environment.status === 'RETIRED';
};

export function EnvironmentRegistry() {
  const [environments, setEnvironments] = useState<ManagedEnvironment[]>([]);
  const [tools, setTools] = useState<ManagedTool[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [baseDetail, setBaseDetail] = useState<EnvironmentDetail | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [form, setForm] = useState<EnvironmentForm>(emptyEnvironmentForm);
  const [savedFormFingerprint, setSavedFormFingerprint] = useState(() =>
    formFingerprint(emptyEnvironmentForm()),
  );
  const [creating, setCreating] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>('definition');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [baseLoading, setBaseLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<EnvironmentFilter>('all');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const loadedEnvironmentId = useRef<string | null>(null);

  const setFormAndBaseline = useCallback((next: EnvironmentForm) => {
    setForm(next);
    setSavedFormFingerprint(formFingerprint(next));
  }, []);

  const loadList = useCallback(async (preferredId?: string) => {
    const values = await environmentsService.list();
    setEnvironments(values);
    setSelectedId((current) => {
      const candidate = preferredId ?? current;
      return candidate && values.some((item) => item.environmentId === candidate)
        ? candidate
        : (values[0]?.environmentId ?? null);
    });
    return values;
  }, []);

  const loadDetail = useCallback(
    async (
      environmentId: string,
      options: { showLoading?: boolean; preferCurrent?: boolean; preserveForm?: boolean } = {},
    ) => {
      const { showLoading = true, preferCurrent = false, preserveForm = false } = options;
      if (showLoading) setDetailLoading(true);
      try {
        const value = await environmentsService.get(environmentId);
        const current =
          value.revisions.find(
            (revision) => revision.revisionId === value.environment.currentRevisionId,
          ) ??
          value.publishedRevision ??
          value.revisions[0] ??
          null;
        if (loadedEnvironmentId.current !== value.environment.environmentId) {
          const definitionAvailable =
            value.environment.environmentId !== 'standard' &&
            Boolean(current) &&
            isCatalogRecipe(current?.recipe);
          setWorkspace(
            definitionAvailable && current?.status === 'DRAFT' ? 'definition' : 'revisions',
          );
          loadedEnvironmentId.current = value.environment.environmentId;
        }
        setDetail(value);
        setSelectedRevisionId((selected) =>
          preferCurrent
            ? (current?.revisionId ?? null)
            : selected && value.revisions.some((revision) => revision.revisionId === selected)
              ? selected
              : (current?.revisionId ?? null),
        );
        if (!preserveForm) setFormAndBaseline(formFromRevision(value.environment, current));
        return value;
      } finally {
        if (showLoading) setDetailLoading(false);
      }
    },
    [setFormAndBaseline],
  );

  useEffect(() => {
    Promise.all([loadList(), toolsService.list(true)])
      .then(([, values]) => setTools(values))
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : 'Failed to load environments'),
      )
      .finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    if (!selectedId || creating) return;
    setError(null);
    void loadDetail(selectedId).catch((reason) =>
      setError(reason instanceof Error ? reason.message : 'Failed to load environment'),
    );
  }, [creating, loadDetail, selectedId]);

  useEffect(() => {
    if (!form.baseEnvironmentId) {
      setBaseDetail(null);
      return;
    }
    let active = true;
    setBaseLoading(true);
    void environmentsService
      .get(form.baseEnvironmentId)
      .then((value) => {
        if (active) setBaseDetail(value);
      })
      .catch((reason) => {
        if (active) {
          setBaseDetail(null);
          setError(reason instanceof Error ? reason.message : 'Failed to load base environment');
        }
      })
      .finally(() => {
        if (active) setBaseLoading(false);
      });
    return () => {
      active = false;
    };
  }, [form.baseEnvironmentId]);

  const selectedRevision = useMemo(
    () => detail?.revisions.find((revision) => revision.revisionId === selectedRevisionId) ?? null,
    [detail, selectedRevisionId],
  );
  const isDirty = formFingerprint(form) !== savedFormFingerprint;

  useEffect(() => {
    if (!selectedId || !selectedRevision || !isActiveRevision(selectedRevision)) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        loadDetail(selectedId, {
          showLoading: false,
          preserveForm: isDirty,
        }),
        loadList(selectedId),
      ]).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [isDirty, loadDetail, loadList, selectedId, selectedRevision]);

  const currentRevision =
    detail?.revisions.find(
      (revision) => revision.revisionId === detail.environment.currentRevisionId,
    ) ?? null;
  const fixedToolEnvironment =
    detail?.environment.environmentId !== 'standard' &&
    Boolean(currentRevision) &&
    !isCatalogRecipe(currentRevision?.recipe);
  const definitionAvailable =
    detail?.environment.environmentId !== 'standard' && !fixedToolEnvironment;

  const baseOptions = environments.filter(
    (environment) =>
      environment.publishedRevisionId &&
      environment.status !== 'RETIRED' &&
      (creating || environment.environmentId !== selectedId),
  );
  const updates = environments.filter((environment) => environment.updateAvailable);
  const activeBaseDetail =
    baseDetail?.environment.environmentId === form.baseEnvironmentId ? baseDetail : null;
  const baseEnvironment =
    environments.find((environment) => environment.environmentId === form.baseEnvironmentId) ??
    activeBaseDetail?.environment ??
    null;
  const baseRevision = activeBaseDetail?.publishedRevision ?? null;

  const filteredEnvironments = environments.filter((environment) => {
    const query = search.trim().toLowerCase();
    return (
      filterEnvironment(environment, filter) &&
      (!query ||
        environment.name.toLowerCase().includes(query) ||
        environment.environmentId.toLowerCase().includes(query) ||
        environment.description.toLowerCase().includes(query))
    );
  });

  const run = async (
    name: string,
    action: () => Promise<unknown>,
    preferredId = selectedId,
    preferCurrent = false,
    preserveForm = false,
  ) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await loadList(preferredId ?? undefined);
      if (preferredId) await loadDetail(preferredId, { preferCurrent, preserveForm });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Environment action failed');
    } finally {
      setBusy(null);
    }
  };

  const createEnvironment = async () => {
    setBusy('create');
    setError(null);
    try {
      const result = await environmentsService.create({
        ...(form.environmentId.trim() ? { environmentId: form.environmentId.trim() } : {}),
        name: form.name.trim(),
        description: form.description.trim(),
        baseEnvironmentId: form.baseEnvironmentId,
        recipe: recipeFromForm(form),
      });
      setCreating(false);
      setSelectedId(result.environment.environmentId);
      await loadList(result.environment.environmentId);
      await loadDetail(result.environment.environmentId, { preferCurrent: true });
      setWorkspace('revisions');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Environment action failed');
    } finally {
      setBusy(null);
    }
  };

  const requestDiscard = (action: () => void) => {
    if (!isDirty) {
      action();
      return;
    }
    setConfirmation({
      title: 'Discard unsaved changes?',
      description:
        'The environment definition has changes that have not been saved as a new revision.',
      actionLabel: 'Discard changes',
      destructive: true,
      onConfirm: action,
    });
  };

  const startCreating = () => {
    const next = emptyEnvironmentForm();
    setCreating(true);
    setDetail(null);
    loadedEnvironmentId.current = null;
    setWorkspace('definition');
    setFormAndBaseline(next);
    setError(null);
  };

  const selectEnvironment = (environmentId: string) => {
    if (!creating && selectedId === environmentId) return;
    requestDiscard(() => {
      setCreating(false);
      setDetail(null);
      setSelectedId(environmentId);
      setError(null);
    });
  };

  const requestRetire = (environment: ManagedEnvironment) =>
    setConfirmation({
      title: `Retire ${environment.name}?`,
      description:
        'Retired environments cannot be changed or assigned to new spaces. Existing intent snapshots remain available.',
      actionLabel: 'Retire environment',
      destructive: true,
      onConfirm: () =>
        void run('retire', () => environmentsService.retire(environment.environmentId)),
    });

  const requestAcceptFindings = (
    environment: ManagedEnvironment,
    revision: EnvironmentRevision,
    critical: number,
    high: number,
  ) =>
    setConfirmation({
      title: 'Accept security findings?',
      description: `Accept ${critical} Critical and ${high} High security findings and continue to runtime validation? The findings remain visible after publication.`,
      actionLabel: 'Accept and continue',
      onConfirm: () =>
        void run(
          'accept-findings',
          () => environmentsService.acceptFindings(environment.environmentId, revision.revisionId),
          environment.environmentId,
          false,
          isDirty,
        ),
    });

  const environment = detail?.environment ?? null;
  const revisionWorkspace =
    environment && detail ? (
      <EnvironmentRevisionWorkspace
        environment={environment}
        detail={detail}
        selectedRevisionId={selectedRevisionId}
        onSelectRevision={setSelectedRevisionId}
        busy={busy}
        onRefresh={() => void loadDetail(environment.environmentId, { preserveForm: isDirty })}
        onRun={(name, action) => void run(name, action, environment.environmentId, false, isDirty)}
        onRequestAccept={(revision, critical, high) =>
          requestAcceptFindings(environment, revision, critical, high)
        }
      />
    ) : null;

  return (
    <>
      <SettingsCard
        icon={<Boxes />}
        title="Managed Environments"
        badge={
          updates.length ? (
            <Badge variant="outline" className={statusClass('UPDATE_AVAILABLE')}>
              {updates.length} update{updates.length === 1 ? '' : 's'}
            </Badge>
          ) : null
        }
        description="Define reusable toolchains, then build and publish immutable runtime revisions."
        headerAction={
          <Button
            size="sm"
            className="gap-1.5"
            disabled={Boolean(busy)}
            onClick={() => requestDiscard(startCreating)}
          >
            <Plus className="h-3.5 w-3.5" />
            New environment
          </Button>
        }
      >
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]">
            <Skeleton className="h-[520px]" />
            <Skeleton className="h-[620px]" />
          </div>
        ) : (
          <div className="grid min-w-0 gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
            <aside className="self-start rounded-xl border bg-muted/10 p-2 lg:sticky lg:top-0">
              <div className="space-y-2 p-1">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    aria-label="Search environments"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search environments"
                    className="h-9 bg-background pl-8 text-xs"
                  />
                </div>
                <Select
                  value={filter}
                  onValueChange={(value) => setFilter(value as EnvironmentFilter)}
                >
                  <SelectTrigger
                    aria-label="Filter environments"
                    className="h-8 bg-background text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All environments</SelectItem>
                    <SelectItem value="attention">Needs attention</SelectItem>
                    <SelectItem value="drafts">In progress</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="retired">Retired</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="mt-1 max-h-[680px] space-y-1 overflow-y-auto">
                {creating && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Plus className="h-3.5 w-3.5 text-primary" />
                      <span className="text-xs font-semibold">New environment</span>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">Unsaved definition</p>
                  </div>
                )}
                {filteredEnvironments.map((item) => (
                  <button
                    key={item.environmentId}
                    type="button"
                    className={cn(
                      'w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                      !creating &&
                        selectedId === item.environmentId &&
                        'border-border bg-background shadow-sm',
                    )}
                    aria-pressed={!creating && selectedId === item.environmentId}
                    onClick={() => selectEnvironment(item.environmentId)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold">{item.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                          {item.environmentId}
                        </span>
                      </span>
                      {item.updateAvailable ? (
                        <span className="mt-0.5 shrink-0 text-amber-600">
                          <TriangleAlert className="h-3.5 w-3.5" />
                          <span className="sr-only">Update available</span>
                        </span>
                      ) : (
                        <StatusBadge
                          status={item.status}
                          className="shrink-0 px-1.5 py-0 text-[8px]"
                        />
                      )}
                    </div>
                    {(item.toolUpdates?.length ?? 0) > 0 && (
                      <span className="mt-1.5 block text-[9px] font-medium text-amber-700 dark:text-amber-300">
                        {item.toolUpdates?.length} recommended tool update
                        {item.toolUpdates?.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>
                ))}
                {filteredEnvironments.length === 0 && (
                  <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                    No environments match this view.
                  </div>
                )}
              </div>
            </aside>

            <div className="min-w-0">
              {creating ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold">Create an environment</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose a base, add tools, and review the composition before creating a
                        draft.
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        requestDiscard(() => {
                          setCreating(false);
                          if (selectedId) void loadDetail(selectedId);
                        })
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                  <EnvironmentBuilder
                    key="new-environment"
                    form={form}
                    onChange={setForm}
                    baseOptions={baseOptions}
                    baseEnvironment={baseEnvironment}
                    baseRevision={baseRevision}
                    baseLoading={baseLoading}
                    tools={tools}
                    disabled={Boolean(busy)}
                    showId
                    actionLabel="Create draft"
                    actionBusy={busy === 'create'}
                    actionDisabled={Boolean(busy) || baseLoading || !baseRevision}
                    onAction={() => void createEnvironment()}
                  />
                </div>
              ) : detailLoading || !environment || !detail ? (
                <Skeleton className="h-[620px]" />
              ) : (
                <div className="space-y-4">
                  <div className="border-b pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold">{environment.name}</h3>
                          <StatusBadge status={environment.status} />
                        </div>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span className="font-mono text-[10px]">{environment.environmentId}</span>
                          {environment.description && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{environment.description}</span>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {environment.updateAvailable &&
                          environment.baseEnvironmentId &&
                          !(environment.toolUpdates?.length ?? 0) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              disabled={Boolean(busy)}
                              onClick={() =>
                                requestDiscard(
                                  () =>
                                    void run(
                                      'rebuild',
                                      () => environmentsService.rebuild(environment.environmentId),
                                      environment.environmentId,
                                      true,
                                    ),
                                )
                              }
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                              Rebuild on latest base
                            </Button>
                          )}
                        {environment.environmentId !== 'standard' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="gap-1.5 text-destructive"
                            disabled={Boolean(busy)}
                            onClick={() => requestRetire(environment)}
                          >
                            <Archive className="h-3.5 w-3.5" />
                            Retire
                          </Button>
                        )}
                      </div>
                    </div>

                    {(environment.toolUpdates?.length ?? 0) > 0 && (
                      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-200">
                        <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span>
                          Recommended tool updates are available. Review the definition and save a
                          new revision to select them.
                        </span>
                      </div>
                    )}
                    {fixedToolEnvironment && (
                      <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-800 dark:text-amber-200">
                        <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span>
                          This fixed-tool environment is read-only. Retire it, then create a new
                          environment from published catalog tools.
                        </span>
                      </div>
                    )}
                  </div>

                  {definitionAvailable ? (
                    <Tabs
                      value={workspace}
                      onValueChange={(value) => setWorkspace(value as Workspace)}
                    >
                      <TabsList>
                        <TabsTrigger value="definition">
                          Definition
                          {isDirty && (
                            <>
                              <span className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500" />
                              <span className="sr-only">Unsaved changes</span>
                            </>
                          )}
                        </TabsTrigger>
                        <TabsTrigger value="revisions">
                          Revisions
                          <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[9px]">
                            {detail.revisions.length}
                          </Badge>
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="definition" className="mt-4">
                        <EnvironmentBuilder
                          key={environment.environmentId}
                          form={form}
                          onChange={setForm}
                          baseOptions={baseOptions}
                          baseEnvironment={baseEnvironment}
                          baseRevision={baseRevision}
                          baseLoading={baseLoading}
                          tools={tools}
                          disabled={Boolean(busy)}
                          showId={false}
                          actionLabel="Save as new revision"
                          actionBusy={busy === 'save'}
                          actionDisabled={Boolean(busy) || baseLoading || !baseRevision || !isDirty}
                          onAction={() =>
                            void run(
                              'save',
                              () =>
                                environmentsService.update(environment.environmentId, {
                                  name: form.name.trim(),
                                  description: form.description.trim(),
                                  baseEnvironmentId: form.baseEnvironmentId,
                                  recipe: recipeFromForm(form),
                                }),
                              environment.environmentId,
                              true,
                            )
                          }
                        />
                      </TabsContent>

                      <TabsContent value="revisions" className="mt-4">
                        {revisionWorkspace}
                      </TabsContent>
                    </Tabs>
                  ) : (
                    revisionWorkspace
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </SettingsCard>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                confirmation?.destructive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              onClick={() => {
                const action = confirmation?.onConfirm;
                setConfirmation(null);
                action?.();
              }}
            >
              {confirmation?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
