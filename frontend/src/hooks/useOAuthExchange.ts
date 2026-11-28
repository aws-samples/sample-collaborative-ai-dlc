import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { JiraPendingChoice } from '@/services/trackers';

type Result = {
  success?: boolean;
  error?: string;
  pendingChoice?: JiraPendingChoice;
  /** Self-managed GitLab host the token was issued by. */
  instance?: string;
};

/** Authorization codes are single use, including when React replays an effect. */
export function useOAuthExchange(callbackPath: string, provider: string): Result | null {
  const [params] = useSearchParams();
  const code = params.get('code');
  const state = params.get('state') ?? '';
  const denied = params.get('error') === 'access_denied';
  const [settled, setSettled] = useState<{ url: string; result: Result } | null>(null);
  const request = useRef<{ url: string; promise: Promise<Result> } | null>(null);
  const url =
    code && !denied
      ? `${import.meta.env.VITE_API_BASE_URL}${callbackPath}?${new URLSearchParams({ code, state })}`
      : null;
  useEffect(() => {
    if (!url) return;
    let active = true;
    if (request.current?.url !== url) {
      request.current = { url, promise: fetch(url).then((response) => response.json()) };
    }
    request.current.promise.then(
      (result) => {
        if (active) setSettled({ url, result: result ?? {} });
      },
      () => {
        if (active)
          setSettled({
            url,
            result: { error: `Could not connect to ${provider}. Try again from settings.` },
          });
      },
    );
    return () => {
      active = false;
    };
  }, [url, provider]);
  if (!url)
    return {
      error: denied
        ? 'Authorization was not granted.'
        : 'The authorization link is incomplete. Start the connection again.',
    };
  return settled?.url === url ? settled.result : null;
}
