import { Outlet } from 'react-router-dom';
import { SprintProvider } from '@/contexts/SprintContext';

/**
 * SprintLayout wraps all phase views (inception, construction, review, graph)
 * with the SprintProvider context, so sprint data is loaded once and shared
 * across all phase transitions without remounting.
 *
 * DiscussionProvider lives one level up in AppShell: the discussion thread
 * renders non-modally inside the ActivityPanel (which sits outside this
 * layout's Outlet) and its Discussions tab shares the same state.
 */
export function SprintLayout() {
  return (
    <SprintProvider>
      <Outlet />
    </SprintProvider>
  );
}
