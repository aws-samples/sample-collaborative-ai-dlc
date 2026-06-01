import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { trackersService } from '@/services/trackers';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { cn } from '@/lib/utils';

interface Props {
  providerId: string;
  label: string;
  configured: boolean;
  onSaved: () => void;
}

export function OAuthProviderCard({ providerId, label, configured, onSaved }: Props) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<'saved' | 'error' | null>(null);
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
      setSaveResult('saved');
      setClientId('');
      setClientSecret('');
      onSaved();
    } catch (err) {
      setSaveResult('error');
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult((prev) => (prev === 'saved' ? null : prev)), 4000);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 pt-5 px-5">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          {label}
          {configured ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-agent-success font-normal">
              <CheckCircle2 className="h-3 w-3" /> Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-normal">
              <XCircle className="h-3 w-3" /> Not configured
            </span>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {configured
            ? 'OAuth app credentials are saved. Enter new values below to rotate.'
            : 'Register an OAuth app with the provider, then paste its credentials below.'}
        </p>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${providerId}-client-id`} className="text-xs">
            Client ID
          </Label>
          <Input
            id={`${providerId}-client-id`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={configured ? 'Enter new Client ID to rotate' : 'Paste from your OAuth app'}
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
            placeholder={
              configured ? 'Enter new Client Secret to rotate' : 'Paste from your OAuth app'
            }
            className="font-mono text-sm h-9"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button size="sm" onClick={handleSave} disabled={!canSave} className="gap-1.5">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {saveResult === 'saved' && (
            <span className="text-xs text-agent-success flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          {saveResult === 'error' && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <XCircle className="h-3.5 w-3.5" /> {errorMessage || 'Failed to save'}
            </span>
          )}
        </div>

        {guide && (
          <div className="border rounded-md bg-muted/30">
            <button
              type="button"
              onClick={() => setGuideOpen((o) => !o)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors"
            >
              <span>How to register a new OAuth app</span>
              {guideOpen ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
            {guideOpen && (
              <div className="px-3 pb-3 pt-1 space-y-3 text-xs text-muted-foreground">
                <a
                  href={guide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  Open {guide.label} <ExternalLink className="h-3 w-3" />
                </a>
                <ol className="list-decimal list-inside space-y-1">
                  {guide.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
                {guide.scopeNote && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Note: {guide.scopeNote}
                  </p>
                )}
                {callbackUrl && (
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">Authorization callback URL</p>
                    <code
                      className={cn(
                        'block bg-background border rounded px-2 py-1 text-[11px] font-mono break-all',
                      )}
                    >
                      {callbackUrl}
                    </code>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
