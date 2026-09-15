import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { agentsService, type BedrockIamConfig, type BedrockIamSetup } from '@/services/agents';

interface Props {
  projectId?: string;
  initial?: BedrockIamConfig;
  onClose: () => void;
  onSave: (config: BedrockIamConfig) => Promise<void>;
}

const download = (name: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

export function BedrockIamWizard({ projectId, initial, onClose, onSave }: Props) {
  const [step, setStep] = useState(0);
  const [brokerRoleArn, setBrokerRoleArn] = useState('');
  const [accountId, setAccountId] = useState(initial?.roleArn.split(':')[4] ?? '');
  const [roleName, setRoleName] = useState(
    initial?.roleArn.split(':role/')[1] ??
      `CollaborativeBedrock-${projectId ? projectId.slice(0, 12) : 'Platform'}`,
  );
  const [region, setRegion] = useState(initial?.region ?? '');
  const [externalId, setExternalId] = useState(initial?.externalId ?? '');
  const [existingRole, setExistingRole] = useState(Boolean(initial));
  const [setup, setSetup] = useState<BedrockIamSetup | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [modelCount, setModelCount] = useState(0);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let active = true;
    agentsService
      .getBedrockIamDefaults(projectId)
      .then((defaults) => {
        if (!active) return;
        if (!defaults.brokerRoleArn)
          throw new Error(
            'The deployment needs the IAM setup update before you can configure a role.',
          );
        setBrokerRoleArn(defaults.brokerRoleArn);
        setAccountId((current) => current || defaults.brokerRoleArn.split(':')[4]);
        setRegion((current) => current || defaults.region);
      })
      .catch((reason) => {
        if (active)
          setError(reason instanceof Error ? reason.message : 'Could not load setup details');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Setup failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    run(async () => {
      const config = {
        roleArn: `arn:${brokerRoleArn.split(':')[1]}:iam::${accountId.trim()}:role/${roleName.trim()}`,
        region: region.trim(),
        ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      };
      const result = await agentsService.generateBedrockIamSetup(config, projectId);
      setSetup(result);
      setVerified(false);
      setStep(1);
    });

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError('Copy failed. You can download the file instead.');
    }
  };

  const codePanel = (title: string, filename: string, content: string) => (
    <section className="min-w-0 space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => copy(filename, content)}>
            <Copy className="mr-1 h-3 w-3" />
            {copied === filename ? 'Copied' : 'Copy'}
            <span className="sr-only"> {title}</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => download(filename, content)}>
            <Download className="mr-1 h-3 w-3" />
            Download
            <span className="sr-only"> {title}</span>
          </Button>
        </div>
      </div>
      <pre className="max-h-44 overflow-auto rounded bg-muted p-3 text-xs">{content}</pre>
    </section>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{projectId ? 'Set up space IAM' : 'Set up Bedrock IAM'}</DialogTitle>
          <DialogDescription>
            Connect an AWS role for Claude Code, OpenCode, and Codex. Kiro keeps its separate API
            key.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-wrap gap-3 text-xs" aria-label="Setup progress">
          {['Connection', 'AWS setup', 'Test and enable'].map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? 'step' : undefined}
              className={step === index ? 'font-semibold text-foreground' : 'text-muted-foreground'}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        {step === 0 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Use this application&apos;s AWS account or enter your central Bedrock account. The
              inference region can differ from the application region.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                Inference AWS account
                <Input
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  placeholder="123456789012"
                  inputMode="numeric"
                  disabled={busy}
                />
              </label>
              <label className="space-y-1 text-sm">
                Bedrock region
                <Input
                  value={region}
                  onChange={(event) => setRegion(event.target.value)}
                  placeholder="eu-west-1"
                  disabled={busy}
                />
              </label>
            </div>
            <label className="block space-y-1 text-sm">
              Inference role name or path
              <Input
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={existingRole}
                onChange={(event) => setExistingRole(event.target.checked)}
                disabled={busy}
              />
              I already have an inference role
            </label>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                External ID (optional)
              </summary>
              <label className="mt-3 block space-y-1">
                External ID required by your AWS administrator
                <Input
                  value={externalId}
                  onChange={(event) => setExternalId(event.target.value)}
                  disabled={busy}
                />
              </label>
            </details>
          </div>
        )}
        {step === 1 && setup && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {existingRole
                ? 'Ask your AWS administrator to add the trust and inference permissions below to your existing role.'
                : 'Open AWS CloudShell in the indicated account and run these commands, or share the downloaded files with your AWS administrator.'}{' '}
              The application generates the configuration; it does not change AWS permissions for
              you.
            </p>
            {!existingRole &&
              codePanel(
                `1. Inference account ${setup.inferenceAccountId}`,
                'bedrock-inference-setup.sh',
                setup.inferenceCommands,
              )}
            {codePanel(
              `${existingRole ? 'Application' : '2. Application'} account ${setup.applicationAccountId}`,
              'bedrock-application-setup.sh',
              setup.applicationCommands,
            )}
            <details open={existingRole}>
              <summary className="cursor-pointer text-sm font-medium">
                Role and trust policies
              </summary>
              <div className="mt-3 space-y-3">
                {codePanel(
                  'Inference role trust policy',
                  'bedrock-trust-policy.json',
                  JSON.stringify(setup.trustPolicy, null, 2),
                )}
                {codePanel(
                  'Inference permissions',
                  'bedrock-inference-policy.json',
                  JSON.stringify(setup.inferencePolicy, null, 2),
                )}
                {codePanel(
                  'Credential broker permission',
                  'bedrock-assume-role-policy.json',
                  JSON.stringify(setup.assumeRolePolicy, null, 2),
                )}
              </div>
            </details>
          </div>
        )}
        {step === 2 && setup && (
          <div className="space-y-4">
            <div className="rounded-md border p-4 text-sm">
              <p className="break-all font-medium">{setup.config.roleArn}</p>
              <p className="mt-1 text-muted-foreground">Bedrock region: {setup.config.region}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Test that the credential broker can assume this role and the runtime can discover
              Bedrock models. This check does not run inference or incur model charges.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  setVerified(false);
                  const result = await agentsService.verifyBedrockIam(setup.config, projectId);
                  if (!result.verified)
                    throw new Error(result.error || 'The connection could not be verified');
                  setModelCount(result.models?.length ?? 0);
                  setVerified(true);
                })
              }
            >
              Test connection
            </Button>
            {verified && (
              <p role="status" className="flex items-start gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Role connected; {modelCount} Claude inference profiles found. Model invocation
                permissions and Codex model availability are checked when used.
              </p>
            )}
            <p className="rounded-md bg-muted p-3 text-sm">
              {projectId
                ? 'New runs in this space will use this IAM role. Existing runs keep their current credentials.'
                : 'New Bedrock runs will use IAM. Personal and space Bedrock API keys will be disabled for new runs. Existing runs can finish with their original keys.'}{' '}
              Choose models available in this region in the model settings.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2">
          {step > 0 && (
            <Button variant="outline" disabled={busy} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          {step === 0 && (
            <Button
              disabled={busy || !brokerRoleArn || !accountId || !region || !roleName}
              onClick={generate}
            >
              Generate AWS setup
            </Button>
          )}
          {step === 1 && (
            <Button disabled={busy} onClick={() => setStep(2)}>
              Continue to test
            </Button>
          )}
          {step === 2 && setup && (
            <Button
              disabled={busy || !verified}
              onClick={() =>
                run(async () => {
                  await onSave(setup.config);
                  onClose();
                })
              }
            >
              {projectId ? 'Use this role for new runs' : 'Enable platform IAM'}
            </Button>
          )}
          {busy && <Loader2 className="h-4 w-4 animate-spin self-center" aria-label="Working" />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
