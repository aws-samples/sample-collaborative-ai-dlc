import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from '@/services/api';
import { projectsService, type ProjectRole, type SpacePermissions } from '@/services/projects';

const denied: SpacePermissions = { read: false, write: false, manage: false };
const SpacePermissionsContext = createContext({
  // Off space routes this context imposes no space-specific restriction.
  readOnly: false,
  loading: false,
  documentEpoch: 0,
  canManage: undefined as boolean | undefined,
  role: null as ProjectRole | null,
  // Whether the platform offers native execution, from the same space response
  // as the permissions. False until that response has loaded.
  nativeExecution: false,
  refresh: () => {},
  denyWrites: () => {},
});

export const useSpacePermissions = () => useContext(SpacePermissionsContext);

export function SpacePermissionsNotice() {
  const { role } = useSpacePermissions();
  if (role !== 'viewer') return null;
  return (
    <div role="status" className="border-b bg-muted px-4 py-2 text-sm text-muted-foreground">
      You have view-only access to this space.
    </div>
  );
}

export function SpacePermissionsProvider({
  projectId,
  children,
}: {
  projectId?: string;
  children: ReactNode;
}) {
  if (!projectId) return children;
  // Reset immediately on navigation; never render a new space with old grants.
  return (
    <ScopedPermissions key={projectId} projectId={projectId}>
      {children}
    </ScopedPermissions>
  );
}

function ScopedPermissions({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [access, setAccess] = useState<{
    permissions: SpacePermissions;
    role: ProjectRole | null;
    nativeExecution: boolean;
    loading: boolean;
    documentEpoch: number;
  }>({
    permissions: denied,
    role: null,
    nativeExecution: false,
    loading: true,
    documentEpoch: 0,
  });
  const hasLoaded = useRef(false);
  const applyAccess = useCallback(
    (permissions: SpacePermissions, role: ProjectRole | null, nativeExecution = false) => {
      hasLoaded.current = true;
      setAccess((current) => ({
        permissions,
        role,
        nativeExecution,
        loading: false,
        // Only a confirmed revocation retires a document that could contain writes.
        documentEpoch:
          current.documentEpoch + Number(current.permissions.write && !permissions.write),
      }));
    },
    [],
  );
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const denyWrites = useCallback(() => {
    generation.current++;
    hasLoaded.current = true;
    setAccess((current) => ({
      permissions: { ...current.permissions, write: false, manage: false },
      role: 'viewer',
      nativeExecution: current.nativeExecution,
      loading: false,
      documentEpoch: current.documentEpoch + Number(current.permissions.write),
    }));
  }, []);
  useEffect(() => {
    let active = true;
    let pending = false;
    let timer: number | undefined;
    let retryDelay = 1_000;
    const load = async () => {
      if (!active || pending) return;
      pending = true;
      window.clearTimeout(timer);
      let nextDelay = 15_000;
      const startedAt = generation.current;
      try {
        const project = await projectsService.get(projectId);
        if (active && generation.current === startedAt)
          applyAccess(
            project.permissions ?? denied,
            project.userRole ?? null,
            project.nativeExecution === 'enabled',
          );
      } catch (error) {
        // A transport/server failure says nothing about membership. Keep the last
        // grant (and unsent edits); the backend still authorizes every write.
        if (
          active &&
          generation.current === startedAt &&
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        )
          applyAccess(denied, null);
        else if (!hasLoaded.current && (!(error instanceof ApiError) || error.status >= 500)) {
          // Recover an initial transient failure promptly without a tight retry loop.
          nextDelay = retryDelay;
          retryDelay = Math.min(retryDelay * 2, 15_000);
        }
      } finally {
        pending = false;
        if (active) timer = window.setTimeout(load, nextDelay);
      }
    };
    void load();
    window.addEventListener('focus', load);
    window.addEventListener('online', load);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('online', load);
    };
  }, [projectId, revision, applyAccess]);
  return (
    <SpacePermissionsContext.Provider
      value={{
        readOnly: !access.permissions.write,
        loading: access.loading,
        documentEpoch: access.documentEpoch,
        canManage: access.permissions.manage,
        role: access.role,
        nativeExecution: access.nativeExecution,
        refresh,
        denyWrites,
      }}
    >
      {children}
    </SpacePermissionsContext.Provider>
  );
}
