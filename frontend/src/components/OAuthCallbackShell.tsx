import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

type Status = 'loading' | 'success' | 'error' | 'custom';

interface Props {
  status: Status;
  providerLabel: string;
  loadingMessage?: string;
  successMessage?: string;
  errorMessage?: string | null;
  // For multi-step callbacks (e.g. Jira's site picker) callers render their
  // own UI alongside the standard shell. Provide it as `children` and pass
  // status='custom' to suppress the built-in spinner/check/error blocks.
  children?: ReactNode;
}

// Centered spinner / green check / red X card used by both /github/callback
// and /trackers/callback/jira-cloud. Both pages used to copy-paste this
// JSX wholesale; consolidating here keeps the visual identity consistent.
export function OAuthCallbackShell({
  status,
  providerLabel,
  loadingMessage,
  successMessage,
  errorMessage,
  children,
}: Props) {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-lg shadow text-center max-w-md w-full">
        {status === 'loading' && (
          <>
            <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto mb-4" />
            <p>{loadingMessage ?? `Connecting ${providerLabel}...`}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <div className="text-green-600 text-4xl mb-4">✓</div>
            <p>{successMessage ?? `${providerLabel} connected! Redirecting...`}</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="text-red-600 text-4xl mb-4">✗</div>
            <p className="text-red-600 mb-4">
              {errorMessage ?? `Failed to connect ${providerLabel}`}
            </p>
            <button
              onClick={() => navigate('/dashboard')}
              className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
            >
              Back to Dashboard
            </button>
          </>
        )}
        {status === 'custom' && children}
      </div>
    </div>
  );
}
