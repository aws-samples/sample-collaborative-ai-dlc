// Re-exports from the unified git provider status hook for backward compatibility.
// New code should import useGitProviderStatus directly.
import { useGitProviderStatus } from './useGitProviderStatus';

export function useGitLabStatus() {
  return useGitProviderStatus('gitlab');
}
