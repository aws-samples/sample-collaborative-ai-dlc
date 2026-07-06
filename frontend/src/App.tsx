import { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/layout/AppShell';
import { SprintLayout } from './components/layout/SprintLayout';
import { TRACKER_PROVIDERS } from './lib/trackerProviders';

// Route-level code splitting: every page loads as its own chunk on first
// navigation instead of shipping the whole app as one bundle (pages pull in
// heavy page-specific deps — graph rendering, syntax highlighting, editors).
// Login stays static so the auth entry point renders without a second fetch.
import Login from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Project = lazy(() => import('./pages/Project'));
const ProjectSettings = lazy(() => import('./pages/ProjectSettings'));
const IntentView = lazy(() => import('./pages/IntentView'));
const InceptionPage = lazy(() => import('./pages/InceptionPage'));
const ConstructionPage = lazy(() => import('./pages/ConstructionPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const SprintGraph = lazy(() => import('./pages/SprintGraph'));
const GitOAuthCallback = lazy(() =>
  import('./pages/GitOAuthCallback').then((m) => ({ default: m.GitOAuthCallback })),
);
const JiraCallback = lazy(() => import('./pages/JiraCallback'));
const Admin = lazy(() => import('./pages/Admin'));
const ObservabilityLayout = lazy(() => import('./pages/ObservabilityLayout'));
const BlockLibrary = lazy(() => import('./pages/BlockLibrary'));
const BlockEditor = lazy(() => import('./pages/BlockEditor'));
const WorkflowList = lazy(() => import('./pages/WorkflowList'));
const WorkflowComposer = lazy(() => import('./pages/WorkflowComposer'));

// Minimal route-transition fallback — chunk loads are fast (same-origin,
// HTTP-cached); a spinner flash would be noisier than a brief blank pane.
const routeFallback = <div className="flex-1" aria-busy="true" />;

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Router>
          <Suspense fallback={routeFallback}>
            <Routes>
              {/* Public routes (no shell) */}
              <Route path="/login" element={<Login />} />
              {/* Git provider OAuth callbacks (GitHub, GitLab) — same shape,
                  driven from the tracker registry. Jira differs (auth-gated +
                  its own component) so it stays a separate route below. */}
              {(['github-issues', 'gitlab-issues'] as const).map((id) => (
                <Route
                  key={id}
                  path={TRACKER_PROVIDERS[id].callbackPath}
                  element={<GitOAuthCallback trackerProviderId={id} />}
                />
              ))}
              <Route
                path={TRACKER_PROVIDERS['jira-cloud'].callbackPath}
                element={
                  <ProtectedRoute>
                    <JiraCallback />
                  </ProtectedRoute>
                }
              />

              {/* Protected routes with AppShell layout */}
              <Route
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route path="/dashboard" element={<Dashboard />} />
                <Route
                  path="/admin"
                  element={
                    <ProtectedRoute requirePlatformAdmin>
                      <Admin />
                    </ProtectedRoute>
                  }
                />
                <Route path="/observability" element={<ObservabilityLayout />} />
                {/* Block + workflow authoring is platform-admin only (the
                    backend rejects mutations for everyone else; these are
                    editor pages, so the whole route is soft-gated). */}
                {[
                  { path: '/blocks', el: <BlockLibrary /> },
                  { path: '/blocks/:type', el: <BlockLibrary /> },
                  { path: '/blocks/:type/new', el: <BlockEditor /> },
                  { path: '/blocks/:type/:id', el: <BlockEditor /> },
                  { path: '/workflows', el: <WorkflowList /> },
                  { path: '/workflows/:workflowId', el: <WorkflowComposer /> },
                ].map(({ path, el }) => (
                  <Route
                    key={path}
                    path={path}
                    element={<ProtectedRoute requirePlatformAdmin>{el}</ProtectedRoute>}
                  />
                ))}
                <Route path="/project/:projectId" element={<Project />} />
                <Route path="/project/:projectId/settings" element={<ProjectSettings />} />
                <Route path="/project/:projectId/intent/:intentId" element={<IntentView />} />

                {/* Sprint routes wrapped in SprintLayout for shared context */}
                <Route path="/project/:projectId/sprint/:sprintId" element={<SprintLayout />}>
                  <Route index element={<InceptionPage />} />
                  <Route path="construction" element={<ConstructionPage />} />
                  <Route path="review" element={<ReviewPage />} />
                  <Route path="agent" element={<AgentPage />} />
                  <Route path="graph" element={<SprintGraph />} />
                </Route>

                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Route>

              <Route path="/" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
