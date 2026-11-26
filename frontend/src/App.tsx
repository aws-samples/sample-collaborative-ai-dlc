import { Suspense } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
  useParams,
} from 'react-router';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider } from './components/theme/ThemeProvider';
import { ProtectedRoute } from './components/ProtectedRoute';
import { TRACKER_PROVIDERS } from './lib/trackerProviders';
import { RouteFallback } from './components/RouteFallback';
import { APP_ROUTES, type RouteEntry } from './routes/registry';
import { AppShell, GitOAuthCallback, JiraCallback, NotFound } from './routes/pages';

// Login stays static so the auth entry point renders without a second fetch;
// every other page is a lazy chunk declared in routes/pages.ts.
import Login from './pages/Login';
import AuthCallback from './pages/AuthCallback';

export { preloadRoute } from './routes/registry';

const routeFallback = <RouteFallback />;

function routeElement({ page: Page, requires }: Pick<RouteEntry, 'page' | 'requires'>) {
  return requires === 'platformAdmin' ? (
    <ProtectedRoute requirePlatformAdmin>
      <Page />
    </ProtectedRoute>
  ) : (
    <Page />
  );
}

// Legacy redirect for the pre-rename /project/* URLs. Rewrites the leading
// path segment to /space while preserving the rest of the path plus any
// query string and hash, so old bookmarks and shared links keep working.
function LegacyProjectRedirect() {
  const params = useParams();
  const { search, hash } = useLocation();
  const rest = params['*'] ?? '';
  return <Navigate to={`/space/${rest}${search}${hash}`} replace />;
}

function AppRouteTree() {
  return (
    <ErrorBoundary>
      <Suspense fallback={routeFallback}>
        <Routes>
          {/* Public routes (no shell) */}
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          {/* Git provider OAuth callbacks (GitHub, GitLab) — same shape,
                  driven from the tracker registry. Jira differs (auth-gated +
                  its own component) so it stays a separate route below. */}
          {(['github-issues', 'gitlab-issues', 'bitbucket-issues'] as const).map((id) => (
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
            {APP_ROUTES.map((entry) => (
              <Route key={entry.path} path={entry.path} element={routeElement(entry)}>
                {entry.children?.map((child) =>
                  child.path ? (
                    <Route key={child.path} path={child.path} element={routeElement(child)} />
                  ) : (
                    <Route key="index" index element={routeElement(child)} />
                  ),
                )}
              </Route>
            ))}

            {/* Legacy redirect: old /project/* bookmarks and links map to
                    the /space/* equivalent, preserving the sub-path + query. */}
            <Route path="/project/*" element={<LegacyProjectRedirect />} />

            <Route path="*" element={<NotFound />} />
          </Route>

          <Route path="/" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Router>
          <AppRouteTree />
        </Router>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
