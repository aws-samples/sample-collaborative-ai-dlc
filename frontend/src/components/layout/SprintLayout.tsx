import { Outlet } from 'react-router-dom';
import { SprintProvider } from '@/contexts/SprintContext';
import { DiscussionProvider } from '@/components/discussion';

/**
 * SprintLayout wraps all phase views (inception, construction, review, graph)
 * with the SprintProvider context, so sprint data is loaded once and shared
 * across all phase transitions without remounting.
 *
 * DiscussionProvider owns the single DiscussionSheet (one open thread at a
 * time) so any entity card in any phase can open a discussion.
 */
export function SprintLayout() {
  return (
    <SprintProvider>
      <DiscussionProvider>
        <Outlet />
      </DiscussionProvider>
    </SprintProvider>
  );
}
