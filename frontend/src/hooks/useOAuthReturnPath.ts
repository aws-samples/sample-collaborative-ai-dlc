import { useEffect, useState } from 'react';

// A successful connection resumes the picker; a denial returns to settings
// without automatically starting the interrupted connection again.
export function useOAuthReturnPath() {
  const [returnTo] = useState(() => {
    const saved = sessionStorage.getItem('oauth_return_to');
    if (!saved?.startsWith('/space/')) return null;
    const url = new URL(saved, window.location.origin);
    return url.origin === window.location.origin &&
      /^\/space\/[^/]+\/settings\/?$/.test(url.pathname)
      ? url
      : null;
  });
  useEffect(() => {
    sessionStorage.removeItem('oauth_return_to');
  }, []);
  if (!returnTo) return { resume: null, back: '/dashboard' };
  const back = new URL(returnTo);
  back.searchParams.delete('reconnectJiraBinding');
  back.searchParams.delete('addJiraProject');
  return {
    resume: `${returnTo.pathname}${returnTo.search}${returnTo.hash}`,
    back: `${back.pathname}${back.search}${back.hash}`,
  };
}
