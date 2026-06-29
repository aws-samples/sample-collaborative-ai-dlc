import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AppShell } from './components/layout/AppShell';
import { SprintLayout } from './components/layout/SprintLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Project from './pages/Project';
import ProjectSettings from './pages/ProjectSettings';
import InceptionPage from './pages/InceptionPage';
import ConstructionPage from './pages/ConstructionPage';
import ReviewPage from './pages/ReviewPage';
import AgentPage from './pages/AgentPage';
import SprintGraph from './pages/SprintGraph';
import { GitOAuthCallback } from './pages/GitOAuthCallback';
import JiraCallback from './pages/JiraCallback';
import Admin from './pages/Admin';
import { TRACKER_PROVIDERS } from './lib/trackerProviders';
import ObservabilityPage from './pages/ObservabilityPage';

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Router>
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
              <Route path="/admin" element={<Admin />} />
              <Route path="/observability" element={<ObservabilityPage />} />
              <Route path="/project/:projectId" element={<Project />} />
              <Route path="/project/:projectId/settings" element={<ProjectSettings />} />

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
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
