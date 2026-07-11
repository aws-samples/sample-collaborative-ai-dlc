// Editor for a project's / the platform's custom MCP servers — a JSON object
// keyed by server name (our author format; the runtime transforms it per CLI).
// Parent owns the raw-string state; this component validates JSON locally and
// renders field-level `issues` returned by the API (see lambda/shared/mcp-validator.js).

import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Plug, AlertCircle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api';
import { agentsService, type McpVerifyResult } from '@/services/agents';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SaveStatusButton, type SaveResult } from '@/components/settings/SaveStatusButton';

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
}: Props) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [verifying, setVerifying] = useState(false);
  const [verifyResults, setVerifyResults] = useState<Record<string, McpVerifyResult> | null>(null);
  const [verifyError, setVerifyError] = useState('');

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
      const resp = await agentsService.verifyMcpServers(value || '{}', projectId);
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
    setSaving(true);
    try {
      await onSave(value);
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
