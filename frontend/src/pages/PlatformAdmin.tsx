// Platform Admin — tabbed replacement for the old single-scroll Admin page.
// Four tabs grouped by concern:
//   Users          → platform-admin role management
//   Agents         → agent credentials + default models
//   Source Control → GitHub (auth mode + OAuth/App config) and GitLab OAuth
//   Trackers       → Jira OAuth, git-backed tracker status, data migration
//
// The active tab is synced to the URL (?tab=…) so views are deep-linkable and
// survive refreshes. Tracker-provider statuses are fetched once here and
// shared by the Source Control and Trackers tabs (both render the same
// underlying per-platform OAuth slots).

import { useSearchParams } from 'react-router-dom';
import { Bot, ClipboardList, GitBranch, Users } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTrackerProviders } from '@/hooks/useTrackerProviders';
import { UserManagementCard } from '@/components/admin/UserManagementCard';
import { AgentCredentialsCard } from '@/components/admin/AgentCredentialsCard';
import { DefaultModelsCard } from '@/components/admin/DefaultModelsCard';
import { GlobalMcpServersCard } from '@/components/admin/GlobalMcpServersCard';
import { GraphEnrichmentCard } from '@/components/admin/GraphEnrichmentCard';
import { StageSkippingCard } from '@/components/admin/StageSkippingCard';
import { SourceControlTab } from '@/components/admin/tabs/SourceControlTab';
import { TrackersTab } from '@/components/admin/tabs/TrackersTab';

const TAB_IDS = ['users', 'agents', 'source-control', 'trackers'] as const;
type TabId = (typeof TAB_IDS)[number];
const DEFAULT_TAB: TabId = 'users';

const isTabId = (value: string | null): value is TabId =>
  value !== null && (TAB_IDS as readonly string[]).includes(value);

export default function PlatformAdmin() {
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

  // Tracker-provider OAuth slot statuses — shared by two tabs.
  const { providers, loading: providersLoading, refresh: refreshProviders } = useTrackerProviders();

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Platform Admin</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Users, agents, source control and issue trackers — all platform-wide settings.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={selectTab}>
          <TabsList className="h-10 gap-1 bg-muted/60 p-1">
            <TabsTrigger value="users" className="gap-1.5 px-3.5">
              <Users className="h-3.5 w-3.5" /> Users
            </TabsTrigger>
            <TabsTrigger value="agents" className="gap-1.5 px-3.5">
              <Bot className="h-3.5 w-3.5" /> Agents
            </TabsTrigger>
            <TabsTrigger value="source-control" className="gap-1.5 px-3.5">
              <GitBranch className="h-3.5 w-3.5" /> Source Control
            </TabsTrigger>
            <TabsTrigger value="trackers" className="gap-1.5 px-3.5">
              <ClipboardList className="h-3.5 w-3.5" /> Trackers
            </TabsTrigger>
          </TabsList>

          <TabsContent value="users" className="mt-5">
            <UserManagementCard />
          </TabsContent>

          <TabsContent value="agents" className="mt-5 space-y-6">
            <AgentCredentialsCard />
            <DefaultModelsCard />
            <GlobalMcpServersCard />
            <GraphEnrichmentCard />
            <StageSkippingCard />
          </TabsContent>

          <TabsContent value="source-control" className="mt-5">
            <SourceControlTab
              providers={providers}
              providersLoading={providersLoading}
              onProvidersChanged={refreshProviders}
            />
          </TabsContent>

          <TabsContent value="trackers" className="mt-5">
            <TrackersTab
              providers={providers}
              providersLoading={providersLoading}
              onProvidersChanged={refreshProviders}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
