// Read-only deployment context for the Platform Admin page: which hostname this
// installation is canonically reachable on, plus environment and region.
//
// Deliberately read-only. The hostname is set by the `app_domain` Terraform
// variable, and changing it needs an ACM certificate, a CloudFront distribution
// update and a frontend rebuild — none of which a settings write could perform.
//
// The value of surfacing it here is correctness: a deployment with a custom
// domain still answers on the CloudFront domain and on every alias, so an admin
// can easily be browsing a hostname that differs from the one the backend puts
// in its OAuth redirect URIs. Providers reject mismatched callbacks at sign-in
// time, which is hard to diagnose after the fact.

import { useState } from 'react';
import { Check, Copy, Globe, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { appOrigin, isNonCanonicalOrigin } from '@/lib/appOrigin';

export function DeploymentInfoCard() {
  const [copied, setCopied] = useState(false);

  const origin = appOrigin();
  const environment = import.meta.env.VITE_ENVIRONMENT;
  const region = import.meta.env.VITE_AWS_REGION;
  const mismatched = isNonCanonicalOrigin();

  const handleCopy = async () => {
    await navigator.clipboard.writeText(origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          Deployment
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <code className="truncate font-mono text-[11px] text-foreground">{origin}</code>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 shrink-0"
            onClick={handleCopy}
            title="Copy application URL"
          >
            {copied ? (
              <Check className="h-3 w-3 text-agent-success" />
            ) : (
              <Copy className="h-3 w-3 text-muted-foreground" />
            )}
          </Button>
        </span>
        {environment && (
          <span className="text-muted-foreground">
            Environment <span className="font-medium text-foreground">{environment}</span>
          </span>
        )}
        {region && (
          <span className="text-muted-foreground">
            Region <span className="font-medium text-foreground">{region}</span>
          </span>
        )}
      </div>
      {mismatched && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            You are browsing <code className="font-mono">{window.location.origin}</code>, which is
            not this deployment&apos;s canonical hostname. OAuth callback URLs shown below use the
            canonical hostname, which is what the providers must be configured with.
          </span>
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        The hostname is configured in Terraform via <code className="font-mono">app_domain</code>.
        Changing it requires a redeploy, and the OAuth callback URL must be updated in each
        provider.
      </p>
    </div>
  );
}
