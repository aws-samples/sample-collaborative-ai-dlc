// Editor for a project's / the platform's custom MCP servers — a JSON object
// keyed by server name (our author format; the runtime transforms it per CLI).
// Parent owns the raw-string state; this component validates JSON locally and
// renders field-level `issues` returned by the API (see lambda/shared/mcp-validator.js).

import { useState, useMemo } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Plug, AlertCircle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api';
import { agentsService, type McpVerifyResult } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';
import { SecretField } from '@/components/settings/SecretField';

// Collect the distinct `${VAR}` refs in env/headers values of a parsed config.
// Mirrors lambda/shared/mcp-validator.js extractSecretRefs (env + headers only).
const REF_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;
function parseSecretRefs(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const refs = new Set<string>();
  const scan = (obj: unknown) => {
    if (!obj || typeof obj !== 'object') return;
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (typeof v === 'string') {
        for (const m of v.matchAll(REF_TOKEN)) refs.add(m[1]);
      }
    }
  };
  for (const server of Object.values(parsed as Record<string, unknown>)) {
    if (!server || typeof server !== 'object') continue;
    const s = server as Record<string, unknown>;
    scan(s.env);
    scan(s.headers);
  }
  return [...refs];
}

// Heuristic: does a config carry an INLINE literal that looks like a secret (a
// long, high-entropy string in an env/headers value that is NOT a `${VAR}` ref)?
// Drives the migration warning (§7) — not a hard error.
const looksSecretLike = (v: string) =>
  !v.includes('${') && v.length >= 20 && /[A-Za-z]/.test(v) && /[0-9\-_]/.test(v);
function hasInlineSecretLikeValue(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json || '{}');
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const scan = (obj: unknown): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    return Object.values(obj as Record<string, unknown>).some(
      (v) => typeof v === 'string' && looksSecretLike(v),
    );
  };
  return Object.values(parsed as Record<string, unknown>).some((server) => {
    if (!server || typeof server !== 'object') return false;
    const s = server as Record<string, unknown>;
    return scan(s.env) || scan(s.headers);
  });
}

interface ValidationIssue {
  path: string;
  message: string;
}

interface Props {
  /** Current value (raw JSON string). Parent owns state. */
  value: string;
  onChange: (next: string) => void;
  /** Persists the value. Throws on failure. */
  onSave: (value: string) => Promise<void>;
  /** True when the user may edit (project admin/owner, or platform admin). */
  canEdit: boolean;
  /** One-line description under the title. */
  description: string;
  /** Card title. Defaults to "Custom Agent MCP Servers". */
  title?: string;
  /** Names of servers already provided globally (shown for reference; a project
   *  entry with the same name overrides the global one). Omit at the global tier. */
  globalServerNames?: string[];
  /** Project id when this is a project-scoped editor; omitted at the global tier
   *  (the backend authorizes from the caller's identity + this id). */
  projectId?: string;
  /** Set-state per stored secret `${VAR}` name (true = a value is in SSM). */
  mcpSecretsSet?: Record<string, boolean>;
  /** Persist a batch of secret values ({ VAR: value }); empty value clears. The
   *  parent maps this to the tier's secret endpoint and refreshes set-state. */
  onSaveSecrets?: (secrets: Record<string, string>) => Promise<void>;
  /** The `${VAR}` refs used by each platform-global server, keyed by server name.
   *  Used at the PROJECT tier to compute survivors (a global server this project
   *  overrides by name does NOT survive) and run the same cross-tier collision
   *  check the backend does. Omit at the global tier. */
  globalServerSecretRefs?: Record<string, string[]>;
}

const PLACEHOLDER =
  '{"my-tool":{"command":"npx","args":["-y","my-mcp-server"],"env":{"API_KEY":"..."}}}';

export function CustomMcpServersSection({
  value,
  onChange,
  onSave,
  canEdit,
  description,
  title = 'MCP Servers',
  globalServerNames,
  projectId,
  mcpSecretsSet = {},
  onSaveSecrets,
  globalServerSecretRefs = {},
}: Props) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState<Record<string, McpVerifyResult> | null>(null);
  const [verifyError, setVerifyError] = useState('');
  // Just-typed secret values, keyed by `${VAR}` name. Written on Save (or via the
  // per-field Save action) and passed to verify as `unsavedSecrets` so a user can
  // Test before saving. Never populated from any server response.
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [savingSecrets, setSavingSecrets] = useState(false);

  // Distinct `${VAR}` refs detected in the current config text.
  const secretRefs = useMemo(() => parseSecretRefs(value), [value]);
  const showMigrationWarning = useMemo(() => hasInlineSecretLikeValue(value), [value]);

  // Client-side cross-tier collision check (project tier). Mirrors the backend:
  // compute SURVIVING global servers (those this project does NOT override by
  // name), then flag a `${VAR}` used by BOTH a surviving global server and this
  // config. A same-name override is correctly NOT a collision (the overridden
  // global server doesn't survive). Fast feedback; the backend re-checks.
  const collidingRef = useMemo(() => {
    const globalNames = Object.keys(globalServerSecretRefs);
    if (!globalNames.length || !secretRefs.length) return null;
    let projectServerNames: string[] = [];
    try {
      const parsed = JSON.parse(value || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        projectServerNames = Object.keys(parsed);
      }
    } catch {
      return null; // invalid JSON — the save-path validator surfaces it
    }
    const overridden = new Set(projectServerNames);
    const survivingGlobalRefs = new Set<string>();
    for (const [serverName, refs] of Object.entries(globalServerSecretRefs)) {
      if (overridden.has(serverName)) continue; // overridden → does not survive
      for (const r of refs) survivingGlobalRefs.add(r);
    }
    return secretRefs.find((v) => survivingGlobalRefs.has(v)) ?? null;
  }, [secretRefs, globalServerSecretRefs, value]);

  const clearErrors = () => {
    setError('');
    setIssues([]);
    setVerifyResults(null);
    setVerifyError('');
  };

  const handleVerify = async () => {
    setError('');
    setIssues([]);
    setVerifyResults(null);
    setVerifyError('');
    try {
      JSON.parse(value || '{}');
    } catch {
      setVerifyError('Must be a valid JSON object');
      return;
    }
    setVerifying(true);
    try {
      const unsaved = Object.fromEntries(Object.entries(secretDrafts).filter(([, v]) => v !== ''));
      const resp = await agentsService.verifyMcpServers(value || '{}', projectId, unsaved);
      if (resp.results) {
        setVerifyResults(resp.results);
      } else {
        if (Array.isArray(resp.issues)) setIssues(resp.issues as ValidationIssue[]);
        setVerifyError(resp.error || 'Verification failed');
      }
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body?.issues)) {
        setIssues(err.body.issues as ValidationIssue[]);
        setVerifyError(
          (typeof err.body?.error === 'string' && err.body.error) || 'Invalid MCP configuration',
        );
      } else {
        setVerifyError(err instanceof Error ? err.message : 'Verification failed');
      }
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    clearErrors();
    setResult(null);
    try {
      JSON.parse(value || '{}');
    } catch {
      setError('Must be a valid JSON object');
      setResult('error');
      return;
    }
    if (collidingRef) {
      setError(
        `\${${collidingRef}} is already used by a platform-wide server — rename your variable, ` +
          `or override that server by name.`,
      );
      setResult('error');
      return;
    }
    setSaving(true);
    try {
      await onSave(value);
      // Persist any typed secret values alongside the config (only non-empty).
      const toWrite = Object.fromEntries(Object.entries(secretDrafts).filter(([, v]) => v !== ''));
      if (onSaveSecrets && Object.keys(toWrite).length) {
        await onSaveSecrets(toWrite);
        setSecretDrafts({});
      }
      setResult('saved');
      setTimeout(() => setResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.body?.issues)) {
        setIssues(err.body.issues as ValidationIssue[]);
        setError(
          (typeof err.body?.error === 'string' && err.body.error) ||
            'Invalid MCP servers configuration',
        );
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save MCP servers');
      }
      setResult('error');
    } finally {
      setSaving(false);
    }
  };

  // Clear a single secret immediately (per-field Clear action).
  const handleClearSecret = async (varName: string) => {
    if (!onSaveSecrets) return;
    setSavingSecrets(true);
    try {
      await onSaveSecrets({ [varName]: '' });
      setSecretDrafts((prev) => {
        const next = { ...prev };
        delete next[varName];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear secret');
    } finally {
      setSavingSecrets(false);
    }
  };

  const hasErrors = !!error || issues.length > 0;

  // At the project tier (globalServerNames provided) append the merge note with
  // the inline list of globally-provided servers. At the global tier the prop is
  // omitted, so just the base description shows.
  const fullDescription = globalServerNames ? (
    <>
      {description} Merged with the platform-wide servers
      {globalServerNames.length > 0 ? (
        <>
          {' ('}
          {globalServerNames.map((name, i) => (
            <span key={name}>
              {i > 0 && ', '}
              <code className="bg-muted px-1 rounded">{name}</code>
            </span>
          ))}
          {')'}
        </>
      ) : null}
      . When names collide, the project entry wins.
    </>
  ) : (
    description
  );

  return (
    <SettingsCard icon={<Plug />} title={title} description={fullDescription}>
      <div className="space-y-3">
        <Textarea
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            clearErrors();
          }}
          className={cn(
            'font-mono text-xs min-h-[120px] resize-y',
            hasErrors && 'border-destructive focus-visible:ring-destructive',
          )}
          spellCheck={false}
          disabled={!canEdit || saving}
          placeholder={PLACEHOLDER}
        />
        {issues.length > 0 && (
          <ul className="text-[11px] text-destructive space-y-0.5 pl-5 list-disc">
            {issues.map((issue, i) => (
              <li key={`${issue.path}-${i}`}>
                {issue.path && (
                  <code className="font-mono text-[10px] bg-destructive/10 px-1 rounded mr-1">
                    {issue.path}
                  </code>
                )}
                {issue.message}
              </li>
            ))}
          </ul>
        )}
        {collidingRef && (
          <p className="text-[11px] text-destructive flex items-start gap-1">
            <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>
              <code className="font-mono">${`{${collidingRef}}`}</code> is already used by a
              platform-wide server. Rename your variable, or override that server by name.
            </span>
          </p>
        )}
        {showMigrationWarning && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-start gap-1">
            <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>
              A value in <code>env</code>/<code>headers</code> looks like an inline secret. Replace
              it with a <code className="font-mono">{'${VAR}'}</code> reference and enter the value
              in the secret field below — inline secrets are stored in cleartext and readable by the
              agent.
            </span>
          </p>
        )}
        {canEdit && secretRefs.length > 0 && (
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <p className="text-[11px] font-medium text-foreground">
              Secret values for the <code className="font-mono">{'${VAR}'}</code> references above
            </p>
            {secretRefs.map((varName) => (
              <SecretField
                key={varName}
                id={`mcp-secret-${projectId ?? 'global'}-${varName}`}
                label={varName}
                isSet={!!mcpSecretsSet[varName]}
                value={secretDrafts[varName] ?? ''}
                onChange={(v) => setSecretDrafts((prev) => ({ ...prev, [varName]: v }))}
                emptyPlaceholder={`Enter the value for ${varName}`}
                onClear={onSaveSecrets ? () => handleClearSecret(varName) : undefined}
                clearing={savingSecrets}
                disabled={saving || savingSecrets}
              />
            ))}
            <p className="text-[10px] text-muted-foreground">
              Values are stored encrypted and never written to the agent's config file or shown here
              again. Typing a value and Saving rotates it; Test uses the typed value even before you
              Save.
            </p>
          </div>
        )}
        {!hasErrors && (
          <p className="text-[11px] text-muted-foreground flex items-start gap-1">
            <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>
              A JSON object of MCP servers keyed by name, merged into the agent's config for the
              selected CLI. Each value: stdio servers use <code>command</code>/<code>args</code>/
              <code>env</code>, remote servers use <code>type</code> (<code>http</code>/
              <code>sse</code>)/<code>url</code>/<code>headers</code>. Bare commands must be one of{' '}
              <code>node</code>, <code>npx</code>, <code>bun</code>, <code>bunx</code>,{' '}
              <code>uv</code>, <code>uvx</code>, <code>python</code>, <code>python3</code> (or an
              absolute path).
            </span>
          </p>
        )}
        {verifyError && (
          <p className="text-[11px] text-destructive flex items-start gap-1">
            <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>{verifyError}</span>
          </p>
        )}
        {verifyResults && (
          <ul className="text-[11px] space-y-1 rounded-md border bg-muted/30 p-2">
            {Object.entries(verifyResults).map(([name, r]) => (
              <li key={name} className="flex items-start gap-1.5">
                {r.ok ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-px text-agent-success" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 mt-px text-destructive" />
                )}
                <span>
                  <code className="font-mono">{name}</code>
                  {r.ok ? (
                    <span className="text-muted-foreground">
                      {' '}
                      — {r.tools?.length ?? 0} tool{(r.tools?.length ?? 0) === 1 ? '' : 's'}
                      {r.tools?.length ? `: ${r.tools.join(', ')}` : ''}
                    </span>
                  ) : (
                    <span className="text-destructive"> — {r.error}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleVerify}
              disabled={verifying || saving}
              className="gap-1.5"
            >
              {verifying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {verifying ? 'Testing…' : 'Test MCP servers'}
            </Button>
            <SaveStatusButton
              onClick={handleSave}
              saving={saving}
              label={`Save ${title}`}
              result={result}
              errorMessage={error}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Only owners and admins can change MCP servers.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
