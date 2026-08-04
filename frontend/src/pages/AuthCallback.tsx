import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import {
  isSsoAccessDeniedError,
  SsoLoginTimeoutError,
  SSO_ACCESS_DENIED_MESSAGE,
  SSO_LOGIN_TIMEOUT_MESSAGE,
} from '@/services/authErrors';

interface CallbackFailure {
  title: string;
  message: string;
}

const accessDeniedFailure: CallbackFailure = {
  title: 'Access denied',
  message: SSO_ACCESS_DENIED_MESSAGE,
};
const timeoutFailure: CallbackFailure = {
  title: 'Sign-in timed out',
  message: SSO_LOGIN_TIMEOUT_MESSAGE,
};

export default function AuthCallback() {
  const { completeSsoLogin } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [failure, setFailure] = useState<CallbackFailure | null>(null);

  useEffect(() => {
    const providerError = searchParams.get('error');
    if (providerError) {
      const description = searchParams.get('error_description');
      const reason = { code: providerError, message: description };
      setFailure(
        isSsoAccessDeniedError(reason)
          ? accessDeniedFailure
          : {
              title: 'Sign-in failed',
              message: description || 'Your enterprise identity provider did not complete sign-in.',
            },
      );
      return;
    }

    let cancelled = false;
    completeSsoLogin()
      .then((returnTo) => {
        if (!cancelled) navigate(returnTo, { replace: true });
      })
      .catch((reason) => {
        console.error('Enterprise sign-in callback failed:', reason);
        if (!cancelled) {
          setFailure(
            isSsoAccessDeniedError(reason)
              ? accessDeniedFailure
              : reason instanceof SsoLoginTimeoutError
                ? timeoutFailure
                : {
                    title: 'Sign-in failed',
                    message:
                      'Enterprise sign-in could not be completed. The request may have expired.',
                  },
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [completeSsoLogin, navigate, searchParams]);

  if (failure) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm border rounded-md p-6 text-center space-y-4">
          <h1 className="text-base font-semibold">{failure.title}</h1>
          <p className="break-words text-sm text-muted-foreground">{failure.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate('/login', { replace: true })}
          >
            <RotateCcw className="h-4 w-4" />
            Try again
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin" />
        Completing sign-in
      </div>
    </main>
  );
}
