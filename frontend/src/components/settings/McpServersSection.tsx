import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/services/api';

interface ValidationIssue {
  path: string;
  message: string;
}

interface Props {
  // Current value (raw JSON string). Parent owns state so the component is pure-presentational.
  value: string;
  onChange: (next: string) => void;
  // Persists the value. Throws on failure.
  onSave: (value: string) => Promise<void>;
  // True when the user is allowed to edit (e.g. project admin/owner).
  canEdit: boolean;
  // Short helper text rendered above the textarea.
  description: string;
  // Title rendered in the card header. Defaults to "MCP Servers".
  title?: string;
}

/**
 * Editor for a JSON-array field of MCP server definitions.
 * Used at both project level and task level — the parent supplies persistence.
 *
 * When the API returns a 400 with `body.issues: [{path, message}]`, those
 * field-level issues are rendered under the textarea. See
 * `lambda/shared/mcp-validator.js` for the schema.
 */
export function McpServersSection({
  value,
  onChange,
  onSave,
  canEdit,
  description,
  title = 'MCP Servers',
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const clearErrors = () => {
    setError('');
    setIssues([]);
  };

  const handleSave = async () => {
    clearErrors();
    try {
      JSON.parse(value);
    } catch {
      setError('Must be a valid JSON array');
      return;
    }
    setSaving(true);
    try {
      await onSave(value);
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
    } finally {
      setSaving(false);
    }
  };

  const hasErrors = !!error || issues.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{description}</p>
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
          disabled={!canEdit}
          placeholder='[{"name":"my-tool","command":"npx","args":["-y","my-mcp-server"]}]'
        />
        {error && (
          <p className="text-[11px] text-destructive flex items-start gap-1">
            <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
            <span>{error}</span>
          </p>
        )}
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
        {canEdit && (
          <div className="flex justify-end">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : `Save ${title}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
