import type { ReactNode } from 'react';

// Single source of truth for tracker-provider metadata on the frontend.
// Replaces hardcoded `'github-issues'` / `'jira-cloud:cloud'` / callback-path
// literals scattered across pages, components, and the OAuth admin guide.
//
// Anything that varies between providers — display strings, OAuth registration
// instructions, callback paths, icon — lives here. UI code looks up by id.

const GitHubIcon = ({ className }: { className?: string }) => (
  <svg
    role="img"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="GitHub"
    className={className}
    fill="currentColor"
  >
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

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
