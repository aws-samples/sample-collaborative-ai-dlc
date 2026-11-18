import { useCallback, useEffect, useRef, useState } from 'react';
import { Code, Copy, ExternalLink, Shield, ShieldCheck } from 'lucide-react';
import { agentsService, type SandboxSettings } from '@/services/agents';
import { ApiError } from '@/services/api';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';

const harnessDomains = (region: string) => [
  {
    name: 'Kiro',
    domains: ['*.kiro.dev', 'q.us-east-1.amazonaws.com', 'codewhisperer.us-east-1.amazonaws.com'],
  },
  {
    name: 'Claude Code',
    domains: [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`],
  },
  {
    name: 'OpenCode',
    domains: [
      `bedrock-runtime.${region}.amazonaws.com`,
      `bedrock.${region}.amazonaws.com`,
      'models.dev',
    ],
  },
  { name: 'Codex', domains: [`bedrock-mantle.${region}.api.aws`] },
];

const format = (config: Record<string, unknown>) => JSON.stringify(config, null, 2);
// SRT validation and storage may reorder object keys without changing the policy.
const comparableJson = (config: unknown) =>
  JSON.stringify(config, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : value,
  );
const parse = (text: string): Record<string, unknown> => {
  const result = JSON.parse(text);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Configuration must be a JSON object.');
  }
  return result;
};
const errorText = (error: unknown) => {
  if (error instanceof ApiError && Array.isArray(error.body?.issues)) {
    return error.body.issues
      .map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`)
      .join('\n');
  }
  return error instanceof Error ? error.message : 'Could not save sandbox settings.';
};

export function AgentSandboxingCard() {
  const [settings, setSettings] = useState<SandboxSettings | null>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<{ text: string; message: string } | null>(null);
  const [requestError, setRequestError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [bedrockRegion, setBedrockRegion] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const help = useRef<HTMLDetailsElement>(null);
  const current = useRef(settings);
  const inFlight = useRef(false);
  const attemptedDraft = useRef<string | null>(null);
  const alive = useRef(true);

  const load = async () => {
    setLoading(true);
    setRequestError('');
    try {
      const response = await agentsService.getSettings();
      const result = response.sandbox;
      if (!result) throw new Error('Sandbox settings are unavailable. Deploy the updated backend.');
      if (!alive.current) return;
      current.current = result;
      setSettings(result);
      setBedrockRegion(response.bedrockRegion ?? null);
      setText(format(result.draft ?? result.applied?.settings ?? result.defaultSettings));
      setEditorError(null);
      setConflict(false);
      attemptedDraft.current = null;
    } catch (error) {
      if (alive.current) setRequestError(errorText(error));
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, []);

  const save = useCallback(
    async (action: 'draft' | 'apply' | 'toggle', editorText = '') => {
      if (!current.current || inFlight.current || conflict) return;
      inFlight.current = true;
      setPending(action);
      setRequestError('');
      if (action !== 'toggle') attemptedDraft.current = editorText;
      try {
        const request = { expectedRevision: current.current.revision };
        const result = await agentsService.updateSandbox(
          action === 'toggle'
            ? { ...request, action, enabled: !current.current.enabled }
            : { ...request, action, config: editorText },
        );
        if (!alive.current) return;
        current.current = result;
        setSettings(result);
        if (action !== 'toggle') setEditorError(null);
      } catch (error) {
        if (!alive.current) return;
        if (error instanceof ApiError && error.status === 409) {
          setConflict(true);
          setRequestError(
            'Another administrator changed these settings. Copy your edits, then reload.',
          );
        } else if (action !== 'toggle' && error instanceof ApiError && error.status === 400) {
          setEditorError({ text: editorText, message: errorText(error) });
        } else {
          setRequestError(errorText(error));
        }
      } finally {
        inFlight.current = false;
        if (alive.current) setPending(null);
      }
    },
    [conflict],
  );

  let syntaxError = '';
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = parse(text);
  } catch (error) {
    syntaxError = errorText(error);
  }
  const appliedSettings = settings?.applied?.settings ?? settings?.defaultSettings;
  const parsedJson = comparableJson(parsed);
  const sameDraft = parsed !== null && parsedJson === comparableJson(settings?.draft);
  const sameApplied = parsed !== null && parsedJson === comparableJson(appliedSettings);
  const validationError = syntaxError || (editorError?.text === text ? editorError.message : '');

  // Syntax is local. After typing pauses, the backend validates the SRT schema
  // and saves only valid configs. Serialize writes to preserve revision checks.
  useEffect(() => {
    if (
      !settings ||
      loading ||
      pending ||
      conflict ||
      syntaxError ||
      sameDraft ||
      (!settings.draft && sameApplied) ||
      attemptedDraft.current === text
    ) {
      return;
    }
    const timer = setTimeout(() => void save('draft', text), 800);
    return () => clearTimeout(timer);
  }, [text, settings, loading, pending, conflict, syntaxError, sameDraft, sameApplied, save]);

  const restore = () => {
    if (!appliedSettings) return;
    setText(format(appliedSettings));
    setEditorError(null);
    attemptedDraft.current = null;
  };

  const showHelp = () => {
    if (!help.current) return;
    help.current.open = true;
    help.current.querySelector('summary')?.focus({ preventScroll: true });
    help.current.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start',
    });
  };

  const copyExample = async (example: string) => {
    try {
      await navigator.clipboard.writeText(example);
    } catch {
      setRequestError('Copy unavailable. Select the example and copy it manually.');
    }
  };

  return (
    <SettingsCard
      icon={settings?.enabled ? <ShieldCheck /> : <Shield />}
      title="Agent sandboxing"
      badge={
        <>
          <span
            className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-600 dark:text-violet-400"
            title="SRT is a beta research preview. Behavior and configuration may change."
          >
            Beta
          </span>
          {settings && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${settings.enabled ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {settings.enabled ? 'Active' : 'Inactive'}
            </span>
          )}
        </>
      }
      description={
        <>
          Uses{' '}
          <a
            className="underline underline-offset-2"
            href="https://github.com/anthropics/sandbox-runtime"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sandbox Runtime (SRT)
          </a>{' '}
          to run agent harnesses and their commands in a sandbox with configurable file and network
          restrictions.
        </>
      }
    >
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="space-y-5">
          {settings && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <label htmlFor="sandbox-enabled" className="text-xs font-medium">
                    Enable sandboxing for new runs
                  </label>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {settings.applied
                      ? 'Uses the applied configuration. Draft edits do not change it.'
                      : 'Uses the starter configuration until you apply changes.'}
                  </p>
                </div>
                <Switch
                  id="sandbox-enabled"
                  checked={settings.enabled}
                  disabled={Boolean(pending) || conflict}
                  onCheckedChange={() => void save('toggle')}
                />
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="sandbox-config" className="text-xs font-medium">
                    Sandbox configuration · JSON
                  </label>
                  <a
                    href="https://github.com/anthropics/sandbox-runtime#configuration"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    SRT configuration reference <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="overflow-hidden rounded-lg border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1">
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <Code className="h-3.5 w-3.5" aria-hidden="true" />
                      SRT settings
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-5 w-5 rounded-full text-xs"
                        title="Network access help"
                        aria-label="Network access help"
                        aria-controls="sandbox-network-help"
                        aria-expanded={helpOpen}
                        onClick={showHelp}
                      >
                        ?
                      </Button>
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={sameApplied || Boolean(pending) || conflict}
                        onClick={restore}
                      >
                        {settings.applied ? 'Restore applied' : 'Restore starter'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={Boolean(syntaxError)}
                        onClick={() => parsed && setText(format(parsed))}
                      >
                        Format JSON
                      </Button>
                    </div>
                  </div>
                  <textarea
                    id="sandbox-config"
                    aria-describedby="sandbox-validation"
                    aria-invalid={Boolean(validationError)}
                    spellCheck={false}
                    className="block min-h-[360px] w-full resize-y bg-background p-4 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                  <div className="flex flex-wrap justify-between gap-2 border-t bg-muted/20 px-3 py-2 text-[11px]">
                    <span
                      id="sandbox-validation"
                      className={
                        validationError
                          ? 'whitespace-pre-wrap text-destructive'
                          : 'text-muted-foreground'
                      }
                    >
                      {validationError ||
                        (sameDraft || sameApplied
                          ? 'SRT configuration is valid'
                          : 'JSON syntax is valid')}
                    </span>
                    <span role="status" className="text-muted-foreground">
                      {validationError || conflict
                        ? 'Not saved'
                        : pending === 'draft'
                          ? 'Validating and saving…'
                          : sameApplied
                            ? settings.applied
                              ? 'Applied configuration'
                              : 'Starter configuration'
                            : sameDraft
                              ? 'Draft autosaved · not applied'
                              : 'Not saved yet'}
                    </span>
                  </div>
                </div>
              </div>
              <details
                id="sandbox-network-help"
                ref={help}
                onToggle={(event) => setHelpOpen(event.currentTarget.open)}
                className="scroll-mt-5 rounded-lg border px-3 py-2 text-xs"
              >
                <summary className="cursor-pointer font-medium">Network access help</summary>
                <div className="mt-3 space-y-3 text-muted-foreground">
                  <p>
                    When <code>strictAllowlist</code> is enabled, use these examples to allow model
                    access for your harnesses.
                  </p>
                  <div className="grid min-w-0 gap-3 md:grid-cols-2">
                    {harnessDomains(bedrockRegion ?? '<bedrock_region>').map(
                      ({ name, domains }) => {
                        const example = `"allowedDomains": ${JSON.stringify(domains, null, 2)}`;
                        return (
                          <div key={name} className="min-w-0 overflow-hidden rounded-md border">
                            <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-1">
                              <span className="font-medium text-foreground">{name}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Copy ${name} allowedDomains`}
                                onClick={() => void copyExample(example)}
                              >
                                <Copy className="mr-1 h-3 w-3" aria-hidden="true" />
                                Copy
                              </Button>
                            </div>
                            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-5 text-foreground">
                              <code className="select-text">{example}</code>
                            </pre>
                          </div>
                        );
                      },
                    )}
                  </div>
                  {!bedrockRegion && (
                    <p>
                      Replace <code>{'<bedrock_region>'}</code> with your inference region.
                    </p>
                  )}
                  <p>
                    Using several harnesses? Combine their domains in one{' '}
                    <code>allowedDomains</code> list inside <code>network</code>.
                  </p>
                  <p>
                    Add any domains your agents need to access: package registries (e.g.{' '}
                    <code>registry.npmjs.org</code>, <code>pypi.org</code>,{' '}
                    <code>repo.maven.apache.org</code>, …), documentation sites (e.g.{' '}
                    <code>docs.aws.amazon.com</code>), APIs (e.g. <code>api.github.com</code>),
                    remote MCP servers (e.g. <code>aws-mcp.eu-central-1.api.aws</code>), …
                  </p>
                  <a
                    href="https://aws-samples.github.io/sample-collaborative-ai-dlc/using-the-platform/agent-sandboxing/#domains-for-each-harness"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Configuration guide and tested limitations <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </details>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  Changes apply to new runs. Running intents keep their settings.
                </p>
                <Button
                  size="sm"
                  disabled={Boolean(validationError) || sameApplied || Boolean(pending) || conflict}
                  onClick={() => void save('apply', text)}
                >
                  {pending === 'apply' ? 'Applying…' : 'Apply configuration'}
                </Button>
              </div>
            </>
          )}
          {requestError && (
            <div role="alert" className="space-y-2 text-xs text-destructive">
              <p>{requestError}</p>
              {(conflict || !settings) && (
                <Button variant="outline" size="sm" onClick={() => void load()}>
                  Reload settings
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
