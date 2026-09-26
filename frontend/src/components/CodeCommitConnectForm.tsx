import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/services/api';
import {
  IAM_ROLE_ARN_PATTERN,
  codecommitService,
  type CodeCommitConnectInfo,
  type CodeCommitRepoList,
  type CodeCommitRoleConnection,
} from '@/services/codecommit';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// The CodeCommit handshake, in the place a Connect button sits for OAuth
// providers. Three steps on one card:
//   1. the platform returns the caller's external id (minted once per user)
//      and renders the exact trust policy;
//   2. the user creates (or updates) an IAM role in the repository account with
//      that trust policy and a permissions policy on their repositories;
//   3. "Test connection" assumes the role with a discover-only session policy
//      and lists the repositories it can see — that result is what the caller
//      uses to let the user pick repositories.
//
// `initial` pre-fills the card for an existing binding (project settings). The
// external id is the caller's own and stable, so the rendered trust policy is
// the one they already pasted.

export interface CodeCommitConnectResult {
  connection: CodeCommitRoleConnection;
  repos: CodeCommitRepoList;
}

interface Props {
  initial?: Partial<CodeCommitRoleConnection>;
  onVerified: (result: CodeCommitConnectResult) => void;
  // Called when the form changes after a successful verification, so the
  // caller can drop a stale repository list.
  onInvalidated?: () => void;
  compact?: boolean;
}

const explain = (error: unknown): string => {
  if (error instanceof ApiError) {
    const code = typeof error.body?.code === 'string' ? error.body.code : '';
    if (code === 'ROLE_ASSUMPTION_DENIED') {
      return 'The role refused the platform. Check the trust policy: every principal below, and this exact external ID.';
    }
    if (code === 'CODECOMMIT_NOT_CONFIGURED') {
      return 'This deployment cannot connect CodeCommit yet — ask a platform admin.';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Connection test failed';
};

export function CodeCommitConnectForm({ initial, onVerified, onInvalidated, compact }: Props) {
  const [info, setInfo] = useState<CodeCommitConnectInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [roleArn, setRoleArn] = useState(initial?.roleArn ?? '');
  const [region, setRegion] = useState(initial?.region ?? '');
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [verified, setVerified] = useState<CodeCommitRepoList | null>(null);
  const [copied, setCopied] = useState<'trust' | 'permissions' | null>(null);

  useEffect(() => {
    let cancelled = false;
    codecommitService
      .connectInfo()
      .then((data) => {
        if (!cancelled) setInfo(data);
      })
      .catch((e) => {
        if (!cancelled) setInfoError(explain(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const policyJson = useMemo(() => (info ? JSON.stringify(info.trustPolicy, null, 2) : ''), [info]);
  const permissionsJson = useMemo(
    () => (info?.permissionsPolicy ? JSON.stringify(info.permissionsPolicy, null, 2) : ''),
    [info],
  );

  const roleArnValid = IAM_ROLE_ARN_PATTERN.test(roleArn.trim());
  const canTest = Boolean(info) && roleArnValid && region.length > 0 && !testing;

  const invalidate = useCallback(() => {
    if (verified) {
      setVerified(null);
      onInvalidated?.();
    }
    setTestError(null);
  }, [verified, onInvalidated]);

  const copy = async (which: 'trust' | 'permissions') => {
    try {
      await navigator.clipboard.writeText(which === 'trust' ? policyJson : permissionsJson);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); the text stays selectable.
    }
  };

  const test = async () => {
    if (!info) return;
    setTesting(true);
    setTestError(null);
    const connection: CodeCommitRoleConnection = {
      roleArn: roleArn.trim(),
      externalId: info.externalId,
      region,
    };
    try {
      // The external id stays server-side: only the role and region are sent.
      const repos = await codecommitService.listRepos({ roleArn: connection.roleArn, region });
      setVerified(repos);
      onVerified({ connection, repos });
    } catch (e) {
      setVerified(null);
      setTestError(explain(e));
    } finally {
      setTesting(false);
    }
  };

  if (infoError) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
        {infoError}
      </div>
    );
  }
  if (!info) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Preparing connection...</p>;
  }

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            1. Trust policy for your IAM role
          </label>
          <button
            type="button"
            onClick={() => copy('trust')}
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            {copied === 'trust' ? 'Copied' : 'Copy JSON'}
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
          In the AWS account that owns the repositories, create an IAM role with this trust policy.
        </p>
        <pre
          className="text-[11px] leading-snug bg-gray-50 dark:bg-gray-900 border dark:border-gray-700 rounded p-2 overflow-auto max-h-40 select-all"
          data-testid="codecommit-trust-policy"
        >
          {policyJson}
        </pre>
        <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1">
          External ID <code className="select-all">{info.externalId}</code> — keep it exactly as
          shown; it is what stops another user from using your role.
        </p>
      </div>

      {permissionsJson && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Permissions policy for the same role
            </label>
            <button
              type="button"
              onClick={() => copy('permissions')}
              className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              {copied === 'permissions' ? 'Copied' : 'Copy JSON'}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Replace the repository ARN with the repositories this space may use (a list is fine).{' '}
            <code>ListRepositories</code> only accepts <code>&quot;*&quot;</code>; everything else
            stays on those repositories. The platform further narrows every call to one repository
            with a session policy.
          </p>
          <pre
            className="text-[11px] leading-snug bg-gray-50 dark:bg-gray-900 border dark:border-gray-700 rounded p-2 overflow-auto max-h-40 select-all"
            data-testid="codecommit-permissions-policy"
          >
            {permissionsJson}
          </pre>
        </div>
      )}

      <div>
        <label
          htmlFor="codecommit-role-arn"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          2. Role ARN
        </label>
        <input
          id="codecommit-role-arn"
          type="text"
          value={roleArn}
          onChange={(e) => {
            setRoleArn(e.target.value);
            invalidate();
          }}
          placeholder="arn:aws:iam::123456789012:role/aidlc-codecommit-access"
          spellCheck={false}
          className="w-full px-3 py-2 border dark:border-gray-600 rounded text-sm font-mono bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
        />
        {roleArn && !roleArnValid && (
          <p className="text-xs text-red-600 mt-1">Enter a full IAM role ARN.</p>
        )}
      </div>

      <div>
        <label
          htmlFor="codecommit-region"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
        >
          Repository region
        </label>
        <Select
          value={region}
          onValueChange={(v) => {
            setRegion(v);
            invalidate();
          }}
        >
          <SelectTrigger id="codecommit-region">
            <SelectValue placeholder="Select the region of the repositories" />
          </SelectTrigger>
          <SelectContent>
            {info.regions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {testError && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          {testError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={test}
          disabled={!canTest}
          className="px-4 py-2 bg-[#FF9900] text-gray-900 rounded hover:bg-[#EC7211] disabled:opacity-50 text-sm font-medium"
        >
          {testing ? 'Testing...' : '3. Test connection'}
        </button>
        {verified && (
          <span className="text-green-600 text-sm">
            Connected: {verified.repositories.length} repositor
            {verified.repositories.length === 1 ? 'y' : 'ies'} visible in {verified.region}
          </span>
        )}
      </div>
    </div>
  );
}
