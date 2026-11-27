import { createContext, useContext } from 'react';

// The shell owns the Create space dialog so it outlives whatever opened it: a
// layout change unmounts the inline sidebar and redirects /spaces to My work,
// and a dialog owned by either would close mid-form.
export const CreateSpaceContext = createContext<(() => void) | null>(null);

export function useOpenCreateSpace(): () => void {
  const open = useContext(CreateSpaceContext);
  if (!open) throw new Error('useOpenCreateSpace must be used inside AppShell');
  return open;
}
