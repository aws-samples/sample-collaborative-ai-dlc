// Project Settings — tabbed settings page for a v2 project, sharing the
// Platform Admin design language (SettingsCard shells, status pills, icon
// tabs, URL-synced ?tab=). Each tab is a self-contained component under
// components/project-settings/; this page only loads the project and routes
// between tabs.

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { projectsService, type Project } from '@/services/projects';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Bot, ClipboardList, GitBranch, Settings2, Users, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GeneralTab } from '@/components/project-settings/GeneralTab';
import { MembersTab } from '@/components/project-settings/MembersTab';
import { AgentTab } from '@/components/project-settings/AgentTab';
import { RepositoriesTab } from '@/components/project-settings/RepositoriesTab';
import { TrackersTab } from '@/components/project-settings/TrackersTab';

const TAB_IDS = ['general', 'members', 'agent', 'source-control', 'trackers'] as const;
type TabId = (typeof TAB_IDS)[number];
const DEFAULT_TAB: TabId = 'general';

const isTabId = (value: string | null): value is TabId =>
  value !== null && (TAB_IDS as readonly string[]).includes(value);

const ROLE_BADGE: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  admin: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  member: 'bg-muted text-muted-foreground border-transparent',
};

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

export default function ProjectSettings() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isTabId(tabParam) ? tabParam : DEFAULT_TAB;

  const selectTab = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === DEFAULT_TAB) next.delete('tab');
        else next.set('tab', value);
        return next;
      },
      { replace: true },
    );
  };

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const proj = await projectsService.get(projectId);
      if (proj.kind !== 'v2') {
        navigate(`/space/${projectId}`, { replace: true });
        return;
      }
      setProject(proj);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load space');
    } finally {
      setLoading(false);
    }
  }, [projectId, navigate]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  // Tabs mutate slices of the project (name, models, …) — merge them in
  // without a full refetch.
  const applyProjectUpdates = (updates: Partial<Project>) =>
    setProject((prev) => (prev ? { ...prev, ...updates } : prev));

  const userRole = project?.userRole;
  const canEdit = userRole === 'owner' || userRole === 'admin';

  if (!projectId) return <div className="p-6">Space not found</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 gap-1.5"
            onClick={() => navigate(`/space/${projectId}`)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Space
          </Button>
          <div className="h-5 w-px bg-border" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight">
              {project?.name ?? 'Space Settings'}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {canEdit ? 'Space settings' : 'Space settings — only space owner or admin can modify'}
            </p>
          </div>
          {userRole && (
            <Badge variant="outline" className={cn('ml-auto text-[10px]', ROLE_BADGE[userRole])}>
              {ROLE_LABELS[userRole]}
            </Badge>
          )}
        </div>

        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <XCircle className="h-4 w-4 shrink-0" /> {error}
          </p>
        )}

        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-96" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : project ? (
          <Tabs value={activeTab} onValueChange={selectTab}>
            <TabsList className="h-10 gap-1 bg-muted/60 p-1">
              <TabsTrigger value="general" className="gap-1.5 px-3.5">
                <Settings2 className="h-3.5 w-3.5" /> General
              </TabsTrigger>
              <TabsTrigger value="members" className="gap-1.5 px-3.5">
                <Users className="h-3.5 w-3.5" /> Members
              </TabsTrigger>
              <TabsTrigger value="agent" className="gap-1.5 px-3.5">
                <Bot className="h-3.5 w-3.5" /> Agent
              </TabsTrigger>
              <TabsTrigger value="source-control" className="gap-1.5 px-3.5">
                <GitBranch className="h-3.5 w-3.5" /> Source Control
              </TabsTrigger>
              <TabsTrigger value="trackers" className="gap-1.5 px-3.5">
                <ClipboardList className="h-3.5 w-3.5" /> Trackers
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="mt-5">
              <GeneralTab
                project={project}
                canEdit={canEdit}
                onProjectUpdated={applyProjectUpdates}
              />
            </TabsContent>

            <TabsContent value="members" className="mt-5">
              <MembersTab projectId={projectId} userRole={userRole} />
            </TabsContent>

            <TabsContent value="agent" className="mt-5">
              <AgentTab
                project={project}
                canEdit={canEdit}
                onProjectUpdated={applyProjectUpdates}
              />
            </TabsContent>

            <TabsContent value="source-control" className="mt-5">
              <RepositoriesTab project={project} canEdit={canEdit} reload={loadProject} />
            </TabsContent>

            <TabsContent value="trackers" className="mt-5">
              <TrackersTab project={project} canEdit={canEdit} reload={loadProject} />
            </TabsContent>
          </Tabs>
        ) : null}
      </div>
    </div>
  );
}
