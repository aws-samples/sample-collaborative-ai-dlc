// Editor for a project's / the platform's custom MCP servers — a JSON object
// keyed by server name (our author format; the runtime transforms it per CLI).
// Parent owns the raw-string state; this component validates JSON locally and
// renders field-level `issues` returned by the API (see lambda/shared/mcp-validator.js).

import { useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Plug, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api';
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
}

const PLACEHOLDER =
  '{"my-tool":{"command":"npx","args":["-y","my-mcp-server"],"env":{"API_KEY":"..."}}}';

export function CustomMcpServersSection({
  value,
  onChange,
  onSave,
  canEdit,
  description,
  title = 'Custom Agent MCP Servers',
  globalServerNames,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>(null);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const clearErrors = () => {
    setError('');
    setIssues([]);
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
        {canEdit ? (
          <SaveStatusButton
            onClick={handleSave}
            saving={saving}
            label={`Save ${title}`}
            result={result}
            errorMessage={error}
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Only owners and admins can change MCP servers.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
