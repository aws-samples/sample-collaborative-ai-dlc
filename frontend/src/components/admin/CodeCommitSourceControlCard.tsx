// Platform-admin card for the single CodeCommit connection (#531). One role in
// the repository account, trusted by the platform principals with the
// deployment's external ID. Space creators never touch IAM: they pick repos
// like any other provider. Follows the GitHub App card pattern (load config,
// edit, "Test & save"); calls go through services/codecommit.ts.
//
// States mirror the approved mockup: first setup (no connection), trust error
// (424 — nothing saved), and configured (summary with Change / Setup guide).

import { useEffect, useMemo, useState } from 'react';
import { CodeCommitIcon } from '@/components/icons/git-providers';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { ConfigStatusBadge } from '@/components/settings/ConfigStatusBadge';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { ApiError } from '@/services/api';
import {
  codecommitAdminService,
  CODECOMMIT_REGIONS,
  IAM_ROLE_ARN_PATTERN,
  type CodeCommitAdminConfig,
} from '@/services/codecommit';

// Pretty-print a policy object for the copy-able code block.
const toJson = (value: Record<string, unknown> | null | undefined) =>
  value ? JSON.stringify(value, null, 2) : '';

function PolicyBlock({ label, json, testId }: { label: string; json: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); the text stays selectable.
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        className="max-h-48 overflow-auto rounded-md border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed select-all"
        data-testid={testId}
      >
        {json}
      </pre>
    </div>
  );
}

// Fill the policy placeholders from what the admin typed, so the first setup
// can copy a usable policy before anything is saved.
const accountFromRoleArn = (roleArn: string) =>
  IAM_ROLE_ARN_PATTERN.test(roleArn.trim()) ? roleArn.trim().split(':')[4] : null;

function SetupGuide({
  config,
  region,
  roleArn,
}: {
  config: CodeCommitAdminConfig;
  region: string;
  roleArn: string;
}) {
  const trustJson = useMemo(() => toJson(config.trustPolicy), [config.trustPolicy]);
  const permissionsJson = useMemo(() => {
    let json = toJson(config.permissionsPolicy);
    const account = accountFromRoleArn(roleArn);
    if (region) json = json.replaceAll('<region>', region);
    if (account) json = json.replaceAll('<account-id>', account);
    return json;
  }, [config.permissionsPolicy, region, roleArn]);
  return (
    <ol className="list-decimal space-y-3.5 pl-5 text-xs text-muted-foreground">
      <li>
        In the repository account, create an IAM role with this trust policy. The external ID{' '}
        <code className="font-mono select-all">{config.externalId}</code> identifies this platform.
        {trustJson && (
          <div className="mt-2">
            <PolicyBlock label="Trust policy" json={trustJson} testId="codecommit-trust-policy" />
          </div>
        )}
      </li>
      <li>
        Attach this permissions policy. It opens only repositories tagged{' '}
        <code className="font-mono">aidlc=true</code>. Or replace the tag condition with an explicit
        list of repository ARNs — the same role, the most restrictive option.
        {permissionsJson && (
          <div className="mt-2">
            <PolicyBlock
              label="Permissions policy (filled in from the region and role ARN above)"
              json={permissionsJson}
              testId="codecommit-permissions-policy"
            />
          </div>
        )}
      </li>
      <li>
        With the tag policy, tag each repository to share with{' '}
        <code className="font-mono">aidlc=true</code>. The value must be exactly{' '}
        <code className="font-mono">true</code>. This tag grants access: limit who can set it, also
        when a repository is created.
      </li>
      <li>Paste the role ARN and region above, then test and save.</li>
    </ol>
  );
}

export function CodeCommitSourceControlCard() {
  const [config, setConfig] = useState<CodeCommitAdminConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form inputs; `editing` drives the summary-vs-form split once a connection
  // exists (first setup starts in the form).
  const [editing, setEditing] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [roleArn, setRoleArn] = useState('');
  const [region, setRegion] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  // A trust failure (424) or other save error. Shown as the "Nothing was saved"
  // banner and ties the role field to the message via aria-describedby.
  const [trustError, setTrustError] = useState<string | null>(null);

  useEffect(() => {
    codecommitAdminService
      .getConfig()
      .then((next) => {
        setConfig(next);
        setRoleArn(next.roleArn ?? '');
        setRegion(next.region ?? '');
        // No connection yet → open the form (and its guide) straight away.
        setEditing(next.roleArn === null);
        setGuideOpen(next.roleArn === null);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : 'Failed to load configuration');
      })
      .finally(() => setLoading(false));
  }, []);

  const configured = Boolean(config?.roleArn);
  const roleArnValid = IAM_ROLE_ARN_PATTERN.test(roleArn.trim());
  const canSave = roleArnValid && region.length > 0 && !saving;

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    setTrustError(null);
    try {
      const fresh = await codecommitAdminService.updateConfig({ roleArn: roleArn.trim(), region });
      setConfig(fresh);
      setRoleArn(fresh.roleArn ?? '');
      setRegion(fresh.region ?? '');
      setEditing(false);
      setGuideOpen(false);
      setSaveResult('saved');
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    } catch (error) {
      // 424 is the trust failure; its body carries { error, hint }. Everything
      // else (400 invalid, 403 non-admin, 5xx) surfaces the same way: nothing
      // was saved.
      const body = (error as ApiError)?.body as { error?: string; hint?: string } | undefined;
      const hint = body?.hint;
      const message =
        body?.error || (error instanceof Error ? error.message : 'Failed to save configuration');
      setTrustError(hint ? `${message} ${hint}` : message);
      setSaveResult('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      icon={<CodeCommitIcon />}
      title="AWS CodeCommit"
      badge={<ConfigStatusBadge ok={configured} notOkTone="warning" />}
      description="One platform connection. Space creators pick repositories and never touch IAM."
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : loadError ? (
        <p className="text-xs text-destructive">{loadError}</p>
      ) : !config ? null : !editing && configured ? (
        // Configured summary.
        <div className="space-y-4">
          <div
            className="flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm"
            role="status"
          >
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-agent-success" aria-hidden />
            <div>
              <p className="font-medium">Connected in {config.region}.</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                To share a repository, tag it <code className="font-mono">aidlc=true</code>, or add
                its ARN to the role policy.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Region</dt>
            <dd>{config.region}</dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd className="font-mono text-xs break-all">{config.roleArn}</dd>
          </dl>
          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Button size="sm" onClick={() => setEditing(true)}>
              Change
            </Button>
            <Button size="sm" variant="outline" onClick={() => setGuideOpen((o) => !o)}>
              {guideOpen ? 'Hide setup guide' : 'Setup guide'}
            </Button>
          </div>
          {guideOpen && (
            <div className="rounded-md border bg-muted/40 p-3.5">
              <SetupGuide config={config} region={region} roleArn={roleArn} />
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Existing spaces keep their role until their next Rebind and verify.
          </p>
        </div>
      ) : (
        // First setup / editing / trust error.
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
            <div className="space-y-1.5">
              <Label htmlFor="codecommit-region" className="text-xs">
                Repository region
              </Label>
              <Select value={region} onValueChange={setRegion} disabled={saving}>
                <SelectTrigger
                  id="codecommit-region"
                  className="h-9"
                  aria-describedby="codecommit-region-help"
                >
                  <SelectValue placeholder="Select a region" />
                </SelectTrigger>
                <SelectContent>
                  {CODECOMMIT_REGIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id="codecommit-region-help" className="text-[11px] text-muted-foreground">
                The policies below use it.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="codecommit-role-arn" className="text-xs">
                Role ARN
              </Label>
              <Input
                id="codecommit-role-arn"
                value={roleArn}
                onChange={(event) => {
                  setRoleArn(event.target.value);
                  if (trustError) setTrustError(null);
                }}
                placeholder="arn:aws:iam::123456789012:role/aidlc-codecommit"
                className="h-9 font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={trustError ? true : undefined}
                aria-describedby={
                  trustError ? 'codecommit-role-arn-error' : 'codecommit-role-arn-help'
                }
              />
              {roleArn && !roleArnValid ? (
                <p id="codecommit-role-arn-help" className="text-[11px] text-destructive">
                  Enter a full IAM role ARN.
                </p>
              ) : (
                <p id="codecommit-role-arn-help" className="text-[11px] text-muted-foreground">
                  Role in the account that owns the repositories.
                </p>
              )}
            </div>
          </div>

          <div className="rounded-md border bg-muted/40">
            <button
              type="button"
              onClick={() => setGuideOpen((o) => !o)}
              aria-expanded={guideOpen}
              className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium"
            >
              Setup guide for the AWS admin
              <span className="text-xs font-normal text-muted-foreground">
                {guideOpen ? 'Hide' : 'Show'}
              </span>
            </button>
            {guideOpen && config && (
              <div className="px-3 pb-3.5">
                <SetupGuide config={config} region={region} roleArn={roleArn} />
              </div>
            )}
          </div>

          {trustError && (
            <div
              className="flex items-start gap-2.5 rounded-md border border-destructive/35 px-3 py-2.5 text-sm"
              role="alert"
              id="codecommit-role-arn-error"
            >
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-destructive" aria-hidden />
              <div>
                <p className="font-semibold">Nothing was saved.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{trustError}</p>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <SaveStatusButton
              onClick={handleSave}
              disabled={!canSave}
              saving={saving}
              label="Test & save"
              savingLabel="Testing…"
              result={saveResult === 'error' ? null : saveResult}
              savedMessage="Saved and verified"
            />
            {configured && (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  setEditing(false);
                  setGuideOpen(false);
                  setTrustError(null);
                  setSaveResult(null);
                  setRoleArn(config.roleArn ?? '');
                  setRegion(config.region ?? '');
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            )}
            {!trustError && (
              <p className="text-[11px] text-muted-foreground">
                Checks that the platform can use the role.
              </p>
            )}
          </div>
        </div>
      )}
    </SettingsCard>
  );
}
