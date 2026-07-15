import type { ReactNode } from 'react';
import { GitHubIcon, GitLabIcon, BitbucketIcon } from '@/components/icons/git-providers';

// Single source of truth for tracker-provider metadata on the frontend.
// Replaces hardcoded `'github-issues'` / `'jira-cloud:cloud'` / callback-path
// literals scattered across pages, components, and the OAuth admin guide.
//
// Anything that varies between providers — display strings, OAuth registration
// instructions, callback paths, icon — lives here. UI code looks up by id.

const JiraIcon = ({ className }: { className?: string }) => (
  <svg
    role="img"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Jira"
    className={className}
    fill="currentColor"
  >
    <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.001-1.005zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z" />
  </svg>
);

export interface TrackerProviderMeta {
  id: string;
  // The single supported instance for now. Multi-instance providers (e.g.
  // multiple Jira sites) would extend this; today every provider has one.
  instance: string;
  displayName: string;
  // Short label for the project page's binding tab strip (e.g. "GitHub").
  tabLabel: string;
  // Panel title used on the issue picker (e.g. "Start a sprint from a GitHub issue").
  panelTitle: string;
  // Per-issue noun in copy (e.g. "GitHub issue", "Jira issue").
  resourceLabel: string;
  // Frontend route the OAuth provider redirects to after the user grants
  // consent. Used by App.tsx's <Route> and any UI that surfaces the URL.
  callbackPath: string;
  icon: (props: { className?: string }) => ReactNode;
  // OAuth-app registration help shown in the Admin panel.
  registration?: {
    url: string;
    label: string;
    steps: string[];
    scopeNote?: string;
  };
}

export const TRACKER_PROVIDERS: Record<string, TrackerProviderMeta> = {
  'github-issues': {
    id: 'github-issues',
    instance: 'public',
    displayName: 'GitHub Issues',
    tabLabel: 'GitHub',
    panelTitle: 'Start a sprint from a GitHub issue',
    resourceLabel: 'GitHub issue',
    callbackPath: '/github/callback',
    icon: GitHubIcon,
    registration: {
      url: 'https://github.com/settings/developers',
      label: 'GitHub Developer Settings',
      steps: [
        'Open GitHub Developer Settings → OAuth Apps → New OAuth App.',
        'Choose an OAuth App (not a GitHub App).',
        'Set Homepage URL to this deployment’s origin (shown below).',
        'Set Authorization callback URL to the value shown below.',
        'Copy the Client ID and generate a Client Secret, then paste both above.',
      ],
    },
  },
  'jira-cloud': {
    id: 'jira-cloud',
    instance: 'cloud',
    displayName: 'Jira Cloud',
    tabLabel: 'Jira',
    panelTitle: 'Start a sprint from a Jira issue',
    resourceLabel: 'Jira issue',
    callbackPath: '/trackers/callback/jira-cloud',
    icon: JiraIcon,
    registration: {
      url: 'https://developer.atlassian.com/console/myapps',
      label: 'Atlassian Developer Console',
      steps: [
        'Open the Atlassian Developer Console → Create → OAuth 2.0 integration.',
        'Under Permissions, add the Jira API and grant scopes: read:jira-work, read:jira-user, offline_access.',
        'Under Authorization, set the Callback URL to the value shown below.',
        'Open the Settings tab and copy the Client ID and Client Secret, then paste both above.',
      ],
      scopeNote: 'offline_access is required to issue refresh tokens — don’t skip it.',
    },
  },
  'gitlab-issues': {
    id: 'gitlab-issues',
    instance: 'public',
    displayName: 'GitLab Issues',
    tabLabel: 'GitLab',
    panelTitle: 'Start a sprint from a GitLab issue',
    resourceLabel: 'GitLab issue',
    callbackPath: '/gitlab/callback',
    icon: GitLabIcon,
    registration: {
      url: 'https://gitlab.com/-/profile/applications',
      label: 'GitLab User Settings → Applications',
      steps: [
        'Open GitLab → User Settings → Applications → Add new application.',
        'Set the Redirect URI to the value shown below.',
        'Grant the api and read_user scopes.',
        'Save, then copy the Application ID (Client ID) and Secret, and paste both above.',
      ],
      scopeNote:
        'GitLab issues reuse your GitLab connection — connecting GitLab also enables issues.',
    },
  },
  'bitbucket-issues': {
    id: 'bitbucket-issues',
    instance: 'public',
    displayName: 'Bitbucket Issues',
    tabLabel: 'Bitbucket',
    panelTitle: 'Start a sprint from a Bitbucket issue',
    resourceLabel: 'Bitbucket issue',
    callbackPath: '/bitbucket/callback',
    icon: BitbucketIcon,
    registration: {
      url: 'https://bitbucket.org/account/settings/app-passwords/',
      label: 'Bitbucket Workspace settings → OAuth consumers',
      steps: [
        'Open Bitbucket → Workspace settings → OAuth consumers → Add consumer.',
        'Set the Callback URL to the value shown below.',
        'Grant these scopes: Account, Repositories, Pull requests.',
        'Save, then copy the Key (Client ID) and Secret, and paste both above.',
      ],
      scopeNote:
        'Bitbucket issues reuse your Bitbucket connection — connecting Bitbucket also enables issues.',
    },
  },
};

const FALLBACK_META: TrackerProviderMeta = {
  id: 'unknown',
  instance: '',
  displayName: 'Tracker',
  tabLabel: 'Tracker',
  panelTitle: 'Start a sprint from a tracker issue',
  resourceLabel: 'issue',
  callbackPath: '',
  icon: () => null,
};

export const getTrackerProvider = (id: string): TrackerProviderMeta =>
  TRACKER_PROVIDERS[id] ?? { ...FALLBACK_META, id, displayName: id, tabLabel: id };
