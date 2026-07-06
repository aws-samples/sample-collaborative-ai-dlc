// OAuth-app credential form for one provider (client id / client secret +
// collapsible setup guide). Card-free so it can live inside the GitHub
// source-control card, the GitLab card, or the Jira tracker card alike.
//
// Progressive disclosure: once credentials are stored the form collapses to a
// compact summary row with a "Rotate" action — no wall of empty inputs.
//
// One OAuth app per platform: for GitHub/GitLab these credentials power BOTH
// repo operations (clone/push/PRs) and issue browsing — the parent card's copy
// is responsible for making that clear.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { trackersService } from '@/services/trackers';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { SaveStatusButton, type SaveResult } from './shared/SaveStatusButton';

interface Props {
  /** Tracker-provider id owning the OAuth secret slot (e.g. 'github-issues'). */
  providerId: string;
  configured: boolean;
  onSaved: () => void;
}

export function OAuthAppConfigForm({ providerId, configured, onSaved }: Props) {
  // Collapsed summary when credentials already exist; expanded form otherwise.
  const [editing, setEditing] = useState(!configured);
  const [justRotated, setJustRotated] = useState(false);

  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResult>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  const meta = getTrackerProvider(providerId);
  const guide = meta.registration;
  const callbackUrl = meta.callbackPath ? `${window.location.origin}${meta.callbackPath}` : null;

  const canSave = clientId.trim() !== '' && clientSecret.trim() !== '' && !saving;

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    setErrorMessage(null);
    try {
      await trackersService.setOAuthConfig(providerId, clientId.trim(), clientSecret.trim());
      setClientId('');
      setClientSecret('');
      onSaved();
      if (configured) {
        // Rotation flow: collapse back and flash confirmation on the summary.
        setEditing(false);
        setJustRotated(true);
        setTimeout(() => setJustRotated(false), 4000);
      } else {
        setSaveResult('saved');
        setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
      }
    } catch (err) {
      setSaveResult('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-3.5 py-2.5">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {justRotated ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-agent-success" />
              <span className="text-agent-success">Credentials updated</span>
            </>
          ) : (
            <>
              <ShieldCheck className="h-3.5 w-3.5 text-agent-success" />
              Credentials stored securely
            </>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          className="h-7 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" /> Rotate
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${providerId}-client-id`} className="text-xs">
            Client ID
          </Label>
          <Input
            id={`${providerId}-client-id`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={configured ? 'New Client ID' : 'Paste from your OAuth app'}
            className="font-mono text-sm h-9"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${providerId}-client-secret`} className="text-xs">
            Client Secret
          </Label>
          <Input
            id={`${providerId}-client-secret`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={configured ? 'New Client Secret' : 'Paste from your OAuth app'}
            className="font-mono text-sm h-9"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <SaveStatusButton
          onClick={handleSave}
          disabled={!canSave}
          saving={saving}
          label="Save credentials"
          result={saveResult}
          errorMessage={errorMessage}
        />
        {configured && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 h-8 text-xs text-muted-foreground"
            onClick={() => {
              setEditing(false);
              setClientId('');
              setClientSecret('');
              setSaveResult(null);
            }}
          >
            Cancel
          </Button>
        )}
      </div>

      {guide && (
        <div>
          <button
            type="button"
            onClick={() => setGuideOpen((o) => !o)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="h-3.5 w-3.5" />
            Setup guide
            {guideOpen ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
          {guideOpen && (
            <div className="mt-2 space-y-3 rounded-lg bg-muted/40 p-3.5 text-xs text-muted-foreground">
              <a
                href={guide.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
              >
                Open {guide.label} <ExternalLink className="h-3 w-3" />
              </a>
              <ol className="list-decimal list-inside space-y-1 leading-relaxed">
                {guide.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {guide.scopeNote && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  Note: {guide.scopeNote}
                </p>
              )}
              {callbackUrl && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">Authorization callback URL</p>
                  <code className="block break-all rounded-md border bg-background px-2 py-1.5 font-mono text-[11px]">
                    {callbackUrl}
                  </code>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
