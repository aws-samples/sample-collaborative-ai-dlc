import { lazyWithPreload } from '@/lib/lazyWithPreload';

// Route-level code splitting: every page loads as its own chunk on first
// navigation instead of shipping the whole app as one bundle (pages pull in
// heavy page-specific deps — graph rendering, syntax highlighting, editors).
// Login and the sign-in callback stay static in App.tsx so the auth entry
// point renders without a second fetch.

// Public login and callbacks do not need the authenticated shell, its
// subscriptions, or the historical sprint runtime.
export const AppShell = lazyWithPreload(() =>
  import('@/components/layout/AppShell').then((m) => ({ default: m.AppShell })),
);
export const SprintLayout = lazyWithPreload(() =>
  import('@/components/layout/SprintLayout').then((m) => ({ default: m.SprintLayout })),
);
export const Dashboard = lazyWithPreload(() => import('@/pages/Dashboard'));
export const Project = lazyWithPreload(() => import('@/pages/Project'));
export const ProjectSettings = lazyWithPreload(() => import('@/pages/ProjectSettings'));
export const IntentView = lazyWithPreload(() => import('@/pages/IntentView'));
export const InceptionPage = lazyWithPreload(() => import('@/pages/InceptionPage'));
export const ConstructionPage = lazyWithPreload(() => import('@/pages/ConstructionPage'));
export const ReviewPage = lazyWithPreload(() => import('@/pages/ReviewPage'));
export const AgentPage = lazyWithPreload(() => import('@/pages/AgentPage'));
export const SprintGraph = lazyWithPreload(() => import('@/pages/SprintGraph'));
export const GitOAuthCallback = lazyWithPreload(() =>
  import('@/pages/GitOAuthCallback').then((m) => ({ default: m.GitOAuthCallback })),
);
export const JiraCallback = lazyWithPreload(() => import('@/pages/JiraCallback'));
export const PlatformAdmin = lazyWithPreload(() => import('@/pages/PlatformAdmin'));
export const ObservabilityLayout = lazyWithPreload(() => import('@/pages/ObservabilityLayout'));
export const BlockLibrary = lazyWithPreload(() => import('@/pages/BlockLibrary'));
export const BlockEditor = lazyWithPreload(() => import('@/pages/BlockEditor'));
export const WorkflowList = lazyWithPreload(() => import('@/pages/WorkflowList'));
export const WorkflowComposer = lazyWithPreload(() => import('@/pages/WorkflowComposer'));
export const NewIntentPage = lazyWithPreload(() => import('@/pages/NewIntentPage'));
export const IntentComposePage = lazyWithPreload(() => import('@/pages/IntentComposePage'));
export const IntentObservabilityPage = lazyWithPreload(
  () => import('@/pages/IntentObservabilityPage'),
);
export const IntentGraphPage = lazyWithPreload(() => import('@/pages/IntentGraphPage'));
export const IntentAuditPage = lazyWithPreload(() => import('@/pages/IntentAuditPage'));
export const AccountSettings = lazyWithPreload(() => import('@/pages/AccountSettings'));
export const NotFound = lazyWithPreload(() => import('@/pages/NotFound'));
