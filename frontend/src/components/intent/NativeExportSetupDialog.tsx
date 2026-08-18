import { useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import type { IntentGate, NativeWorkflowExport } from '@/services/intents';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

const workspaceDirectoryName = (value?: string | null) => {
  const name = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^\p{ASCII}]/gu, '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80)
    .replace(/[._-]+$/g, '');
  return name || 'aidlc-workspace';
};

const CommandBlock = ({ children, label }: { children: string; label: string }) => {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative mt-2 min-w-0">
      <pre className="w-full min-w-0 max-w-full whitespace-pre-wrap break-all rounded-md bg-muted py-2 pl-3 pr-10 font-mono text-xs leading-relaxed">
        <code>{children}</code>
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1.5 top-1.5 h-7 w-7"
        aria-label={copied ? `${label} copied` : label}
        title={copied ? 'Copied' : label}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>
    </div>
  );
};

interface NativeExportSetupDialogProps {
  exportResult: NativeWorkflowExport | null;
  projectName?: string | null;
  handoffGate?: IntentGate | null;
  onClose: () => void;
}

export function NativeExportSetupDialog({
  exportResult,
  projectName,
  handoffGate = null,
  onClose,
}: NativeExportSetupDialogProps) {
  const setup = exportResult?.setup ?? null;
  const externalDevelopment = handoffGate?.externalDevelopment ?? null;
  const isHandoff = Boolean(externalDevelopment);
  const showSetup = setup?.showWorkspaceSetup ?? false;
  const showInstructions = showSetup || isHandoff;
  const exportDirectory = workspaceDirectoryName(projectName);
  const downloadedZip = exportResult
    ? `"$HOME/Downloads/${exportResult.filename}"`
    : '"$HOME/Downloads/aidlc-workspace.zip"';
  const extractCommands = [
    `mkdir ${shellQuote(exportDirectory)}`,
    `cd ${shellQuote(exportDirectory)}`,
    `unzip ${downloadedZip} -d .`,
  ].join('\n');
  const legacyConstruction = setup?.construction?.perUnitIteration === false;
  const completedUnitSummary = setup?.construction?.completedUnits.join(', ');
  const constructionContinueCommand =
    legacyConstruction && setup?.construction?.nextUnit && setup.continueCommand
      ? [
          `${setup.continueCommand} Continue the construction phase.`,
          completedUnitSummary ? `Completed units: ${completedUnitSummary}.` : '',
          `Continue with unit: ${setup.construction.nextUnit}.`,
        ]
          .filter(Boolean)
          .join(' ')
      : setup?.continueCommand;
  const launchCommand = setup?.launchCommand ?? null;
  const repositories =
    setup?.repositories.length || !externalDevelopment
      ? (setup?.repositories ?? [])
      : externalDevelopment.repositories.map((repository, index, all) => ({
          id: repository.name || repository.repository,
          directory:
            all.length === 1
              ? '.'
              : repository.name || repository.repository.split('/').pop() || `repo-${index + 1}`,
          url: repository.repository,
          branch: repository.branch,
        }));
  const unitName = handoffGate?.unitSlug ?? 'unit';

  return (
    <AlertDialog
      open={exportResult !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-4xl min-w-0 overflow-x-hidden overflow-y-scroll [&>*]:min-w-0">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isHandoff
              ? `Set up external code generation for ${unitName}`
              : showSetup
                ? 'Set up your local workspace'
                : 'Workspace downloaded with warnings'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isHandoff
              ? 'The workspace download is in progress. Complete code generation on the assigned branches, then submit the generated plan and summary to resume Collaborative AI-DLC.'
              : showSetup
                ? 'The workspace download is in progress. Source code should be retrieved separately from Git using your own credentials.'
                : 'Review these warnings before continuing with the downloaded workspace.'}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {!!exportResult?.warnings.length && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            <div className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
              Export warnings
            </div>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {exportResult.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {showInstructions && setup?.mode === 'workspace-sync' && (
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Create an empty workspace directory and extract the downloaded ZIP:
              <CommandBlock label="Copy extraction commands">{extractCommands}</CommandBlock>
            </li>
            <li>
              Clone the repositories declared by the export:
              <CommandBlock label="Copy workspace sync command">
                {setup.syncCommand ?? ''}
              </CommandBlock>
              <p className="mt-1 text-xs text-muted-foreground">
                This reads <code>repos.json</code> and clones{' '}
                {repositories.length === 1
                  ? 'the repository'
                  : `all ${repositories.length} repositories`}
                {' on their declared intent branches.'}
              </p>
            </li>
            <li>
              Start the selected harness:
              {launchCommand ? (
                <CommandBlock label="Copy harness command">{launchCommand}</CommandBlock>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Open this directory in Kiro IDE.
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Open this directory in your IDE. VS Code users may open{' '}
                <code>aidlc.code-workspace</code>.
              </p>
            </li>
            <li>
              Then run inside the agent session:
              <CommandBlock label="Copy AI-DLC command">
                {constructionContinueCommand ?? ''}
              </CommandBlock>
            </li>
          </ol>
        )}

        {showInstructions && setup?.mode === 'manual-workspace' && (
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Create an empty workspace directory and extract the downloaded ZIP:
              <CommandBlock label="Copy extraction commands">{extractCommands}</CommandBlock>
            </li>
            <li>
              Clone each repository into the workspace:
              {repositories.map((repository) => (
                <div key={repository.id} className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium">Fresh clone: {repository.id}</p>
                    <CommandBlock label={`Copy fresh clone command for ${repository.id}`}>
                      {`git clone --branch ${shellQuote(repository.branch)} ${shellQuote(repository.url)} ${shellQuote(repository.directory)}`}
                    </CommandBlock>
                  </div>
                  <div>
                    <p className="text-xs font-medium">Existing clone: {repository.id}</p>
                    <CommandBlock label={`Copy existing clone commands for ${repository.id}`}>
                      {[
                        `git -C ${shellQuote(repository.directory)} fetch origin`,
                        `git -C ${shellQuote(repository.directory)} switch ${shellQuote(repository.branch)}`,
                        `git -C ${shellQuote(repository.directory)} pull --ff-only`,
                      ].join('\n')}
                    </CommandBlock>
                  </div>
                </div>
              ))}
              <p className="mt-2 text-xs text-muted-foreground">
                Keep these repositories as immediate children of the workspace, alongside{' '}
                <code>aidlc/</code> and the harness directory.
              </p>
            </li>
            <li>
              Start the selected harness:
              {launchCommand ? (
                <CommandBlock label="Copy harness command">{launchCommand}</CommandBlock>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Open this directory in Kiro IDE.
                </p>
              )}
            </li>
            <li>
              Then run inside the agent session:
              <CommandBlock label="Copy AI-DLC command">
                {constructionContinueCommand ?? ''}
              </CommandBlock>
            </li>
          </ol>
        )}

        {showInstructions && setup?.mode === 'manual-clone' && (
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Retrieve the source repository and its intent branch:
              {repositories.map((repository) => (
                <div key={repository.id} className="mt-3 space-y-3">
                  <div>
                    <p className="text-xs font-medium">Fresh clone</p>
                    <CommandBlock label={`Copy fresh clone commands for ${repository.id}`}>
                      {[
                        `git clone --branch ${shellQuote(repository.branch)} ${shellQuote(repository.url)} ${shellQuote(repository.directory)}`,
                        `cd ${shellQuote(repository.directory)}`,
                      ].join('\n')}
                    </CommandBlock>
                  </div>
                  <div>
                    <p className="text-xs font-medium">Existing clone</p>
                    <CommandBlock label={`Copy existing clone commands for ${repository.id}`}>
                      {[
                        `cd ${shellQuote(`/path/to/${repository.directory}`)}`,
                        'git fetch origin',
                        `git switch ${shellQuote(repository.branch)}`,
                        'git pull --ff-only',
                      ].join('\n')}
                    </CommandBlock>
                  </div>
                </div>
              ))}
            </li>
            <li>
              From the repository root, extract the downloaded workspace:
              <CommandBlock label="Copy extraction command">
                {`unzip ${downloadedZip} -d .`}
              </CommandBlock>
            </li>
            <li>
              Start the selected harness:
              {launchCommand ? (
                <CommandBlock label="Copy harness command">{launchCommand}</CommandBlock>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Open this directory in Kiro IDE.
                </p>
              )}
            </li>
            <li>
              Then run inside the agent session:
              <CommandBlock label="Copy AI-DLC command">
                {constructionContinueCommand ?? ''}
              </CommandBlock>
            </li>
          </ol>
        )}

        {showInstructions && setup?.mode === 'extract-only' && (
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Create a project directory and extract the downloaded workspace:
              <CommandBlock label="Copy extraction commands">{extractCommands}</CommandBlock>
            </li>
            <li>Open the extracted workspace directory in your IDE.</li>
            <li>
              Start the selected harness:
              {launchCommand ? (
                <CommandBlock label="Copy harness command">{launchCommand}</CommandBlock>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Open this directory in Kiro IDE.
                </p>
              )}
            </li>
            <li>
              Then run inside the agent session:
              <CommandBlock label="Copy AI-DLC command">
                {constructionContinueCommand ?? ''}
              </CommandBlock>
            </li>
          </ol>
        )}

        {isHandoff && (
          <div className="space-y-3 border-t pt-4 text-sm">
            <p className="font-medium">Finish and return the unit</p>
            <ol className="list-decimal space-y-4 pl-5">
              <li>
                Complete only the unit&apos;s <code>code-generation</code> stage. The workspace
                contains the workflow context and assigned branches; later stages remain owned by
                Collaborative AI-DLC.
              </li>
              <li>
                Locate the generated plan and summary before submitting:
                <CommandBlock label="Copy document lookup command">
                  {
                    "find . -type f \\( -name 'code-generation-plan.md' -o -name 'code-summary.md' \\) -print"
                  }
                </CommandBlock>
              </li>
              <li>
                From the workspace root, review and stage only source changes, then commit and push
                each assigned branch:
                {repositories.map((repository) => (
                  <div key={repository.id} className="mt-3">
                    <p className="text-xs font-medium">
                      {repository.id}: <code>{repository.branch}</code>
                    </p>
                    <CommandBlock label={`Copy commit and push commands for ${repository.id}`}>
                      {[
                        `git -C ${shellQuote(repository.directory)} status --short`,
                        `git -C ${shellQuote(repository.directory)} add -p`,
                        `git -C ${shellQuote(repository.directory)} commit -m ${shellQuote(`Implement ${unitName} code generation`)}`,
                        `git -C ${shellQuote(repository.directory)} push origin ${shellQuote(repository.branch)}`,
                      ].join('\n')}
                    </CommandBlock>
                  </div>
                ))}
              </li>
              <li>
                Return to the external-development gate, select the generated{' '}
                <code>code-generation-plan.md</code> and <code>code-summary.md</code>, then choose{' '}
                <strong>Submit</strong>. Collaborative AI-DLC will validate the pushed branch heads
                and both documents before resuming the unit.
              </li>
            </ol>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>Done</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
