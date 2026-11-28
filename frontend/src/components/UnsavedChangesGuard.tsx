import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useBlocker } from 'react-router';
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

export interface UnsavedChangesGuardOptions {
  /**
   * Query parameters whose change must also be guarded while this form is
   * dirty. By default `tab` and `view` switch an editor's internal view without
   * replacing its draft; a settings form whose draft lives inside one tab
   * passes `['tab']`.
   */
  guardSearchParams?: readonly string[];
}

interface DirtyRegistration {
  dirty: boolean;
  guardSearchParams: readonly string[];
}

interface DirtyRegistry {
  set: (id: string, registration: DirtyRegistration) => void;
  remove: (id: string) => void;
}

const DirtyContext = createContext<DirtyRegistry | null>(null);

const EMPTY: readonly string[] = [];

/**
 * Register a dirty authoring form with the nearest route-level guard when one
 * exists. Several forms can be registered at once; the guard blocks while any
 * of them is dirty. Pages can still render in the ordinary MemoryRouter used by
 * their unit tests.
 */
export function useUnsavedChangesGuard(dirty: boolean, options?: UnsavedChangesGuardOptions): void {
  const registry = useContext(DirtyContext);
  const id = useId();
  const guardKey = (options?.guardSearchParams ?? EMPTY).join('\u0000');
  useEffect(() => {
    if (!registry) return;
    registry.set(id, { dirty, guardSearchParams: guardKey ? guardKey.split('\u0000') : EMPTY });
    return () => registry.remove(id);
  }, [dirty, guardKey, id, registry]);
}

const INTERNAL_VIEW_PARAMS = ['tab', 'view'] as const;

const relevantSearch = (search: string, ignored: ReadonlySet<string>) => {
  const params = new URLSearchParams(search);
  for (const key of ignored) params.delete(key);
  return [...params.entries()].toSorted(
    ([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue),
  );
};

function hasMeaningfulLocationChange(
  current: { pathname: string; search: string },
  next: { pathname: string; search: string },
  ignored: ReadonlySet<string>,
): boolean {
  if (current.pathname !== next.pathname) return true;
  return (
    JSON.stringify(relevantSearch(current.search, ignored)) !==
    JSON.stringify(relevantSearch(next.search, ignored))
  );
}

interface DirtyState {
  dirty: boolean;
  ignored: ReadonlySet<string>;
}

const CLEAN: DirtyState = { dirty: false, ignored: new Set(INTERNAL_VIEW_PARAMS) };

function deriveDirtyState(registrations: Iterable<DirtyRegistration>): DirtyState {
  const ignored = new Set<string>(INTERNAL_VIEW_PARAMS);
  let dirty = false;
  for (const registration of registrations) {
    if (!registration.dirty) continue;
    dirty = true;
    for (const key of registration.guardSearchParams) ignored.delete(key);
  }
  return dirty ? { dirty, ignored } : CLEAN;
}

export function UnsavedChangesGuard({ children }: { children: ReactNode }) {
  const registrations = useRef(new Map<string, DirtyRegistration>());
  const [state, setState] = useState<DirtyState>(CLEAN);
  const [registry] = useState<DirtyRegistry>(() => ({
    set: (id, registration) => {
      registrations.current.set(id, registration);
      setState(deriveDirtyState(registrations.current.values()));
    },
    remove: (id) => {
      registrations.current.delete(id);
      setState(deriveDirtyState(registrations.current.values()));
    },
  }));

  const shouldBlock = useCallback(
    ({
      currentLocation,
      nextLocation,
    }: {
      currentLocation: { pathname: string; search: string };
      nextLocation: { pathname: string; search: string };
    }) => state.dirty && hasMeaningfulLocationChange(currentLocation, nextLocation, state.ignored),
    [state],
  );
  const blocker = useBlocker(shouldBlock);
  const blocked = blocker.state === 'blocked';
  const skipCloseReset = useRef(false);

  return (
    <DirtyContext.Provider value={registry}>
      {children}
      <AlertDialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && blocked) {
            if (skipCloseReset.current) {
              skipCloseReset.current = false;
              return;
            }
            blocker.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes will be lost if you leave this editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                skipCloseReset.current = true;
                if (blocker.state === 'blocked') blocker.reset();
              }}
            >
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                skipCloseReset.current = true;
                if (blocker.state === 'blocked') blocker.proceed();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DirtyContext.Provider>
  );
}
