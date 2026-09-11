import { useRef, useState } from 'react';
import { Check, ChevronDown, Download, RotateCcw, Send, Upload } from 'lucide-react';
import {
  NATIVE_EXPORT_HARNESS_OPTIONS,
  type GateAnswer,
  type IntentGate,
  type NativeExportHarness,
  type NativeHandoffDocuments,
} from '@/services/intents';
import { CopyableCommandBlock } from '@/components/intent/CopyableCommandBlock';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export interface ExternalDevelopmentGateCardProps {
  gate: IntentGate;
  workspaceDownloaded?: boolean;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
  onExport?: (gate: IntentGate, harness: NativeExportHarness) => Promise<void>;
  onSubmit?: (gate: IntentGate, documents: NativeHandoffDocuments) => Promise<void>;
}

export function ExternalDevelopmentGateCard({
  gate,
  workspaceDownloaded = false,
  onAnswer,
  onExport,
  onSubmit,
}: ExternalDevelopmentGateCardProps) {
  const [exporting, setExporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planFile, setPlanFile] = useState<File | null>(null);
  const [summaryFile, setSummaryFile] = useState<File | null>(null);
  const unitName = gate.unitSlug ?? 'unit';
  const defaultHarness =
    NATIVE_EXPORT_HARNESS_OPTIONS.find(({ value }) => value === gate.externalDevelopment?.harness)
      ?.value ?? 'kiro';
  const [selectedHarness, setSelectedHarness] = useState<NativeExportHarness>(defaultHarness);
  const planInputRef = useRef<HTMLInputElement>(null);
  const summaryInputRef = useRef<HTMLInputElement>(null);

  return (
    <Card>
      <CardContent className="space-y-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {gate.unitSlug && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-normal">
              unit {gate.unitSlug}
            </Badge>
          )}
        </div>
        <p className="text-sm font-medium">External code generation</p>
        <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">
          {workspaceDownloaded
            ? 'Complete code generation in the downloaded workspace. Commit and push source changes to the assigned branches, then upload the generated plan and summary below. Submitting both documents lets Collaborative AI-DLC validate the result and resume this unit.'
            : 'Download this unit’s code-generation workspace and continue in your preferred IDE, CLI, hosted workspace, or remote agent. Work on the assigned branches and push your source changes. When finished, return here to upload the generated plan and summary so Collaborative AI-DLC can resume the unit.'}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-md">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  className="h-8 w-8 rounded-r-none border-r border-primary-foreground/20"
                  disabled={exporting || !onExport}
                  aria-label="Choose external development harness"
                >
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {NATIVE_EXPORT_HARNESS_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    disabled={exporting}
                    onClick={() => setSelectedHarness(option.value)}
                  >
                    <span>{option.label}</span>
                    {option.value === selectedHarness && (
                      <Check className="ml-auto h-4 w-4" aria-label="Selected harness" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="sm"
              className="rounded-l-none"
              disabled={exporting || !onExport}
              onClick={async () => {
                if (!onExport) return;
                setExporting(true);
                try {
                  await onExport(gate, selectedHarness);
                } finally {
                  setExporting(false);
                }
              }}
            >
              <Download className="h-4 w-4" />
              {exporting ? 'Preparing workspace...' : 'Download workspace'}
            </Button>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={cancelling}
            onClick={async () => {
              if (
                !window.confirm(
                  'Cancel external development and run code generation in Collaborative AI-DLC?',
                )
              ) {
                return;
              }
              setCancelling(true);
              setError(null);
              try {
                await onAnswer(gate, {
                  status: 'answered',
                  answer: { decision: 'run-managed' },
                });
              } catch (cancelError) {
                setError(
                  cancelError instanceof Error
                    ? cancelError.message
                    : 'Failed to cancel external development',
                );
              } finally {
                setCancelling(false);
              }
            }}
          >
            <RotateCcw className="h-4 w-4" />
            {cancelling ? 'Cancelling...' : 'Cancel external development'}
          </Button>
        </div>
        {workspaceDownloaded && (
          <div className="space-y-4 border-t pt-3">
            <div className="space-y-3 text-xs">
              <p className="font-medium">Finish and return the unit</p>
              <ol className="list-decimal space-y-3 pl-5 text-muted-foreground">
                <li>
                  Complete only the unit&apos;s <code>code-generation</code> stage. Later stages
                  remain owned by Collaborative AI-DLC.
                </li>
                <li>
                  Locate the generated plan and summary:
                  <CopyableCommandBlock label="Copy document lookup command">
                    {
                      "find . -type f \\( -name 'code-generation-plan.md' -o -name 'code-summary.md' \\) -print"
                    }
                  </CopyableCommandBlock>
                </li>
                <li>
                  From each repository root, review and stage only source changes, then commit and
                  push its assigned branch:
                  {gate.externalDevelopment?.repositories.map((repository) => (
                    <div key={repository.repository} className="mt-3">
                      <CopyableCommandBlock
                        label={`Copy commit and push commands for ${repository.name}`}
                      >
                        {[
                          'git status --short',
                          'git add -p',
                          `git commit -m ${shellQuote(`Implement ${unitName} code generation`)}`,
                          `git push origin ${shellQuote(repository.branch)}`,
                        ].join('\n')}
                      </CopyableCommandBlock>
                    </div>
                  ))}
                </li>
              </ol>
            </div>
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs font-medium">Submit completed code generation</p>
              <p className="text-xs text-muted-foreground">
                After pushing all source changes, select the generated{' '}
                <code>code-generation-plan.md</code> and <code>code-summary.md</code>, then submit
                them together. Collaborative AI-DLC will validate the branch heads and documents
                before resuming the unit.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => planInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  {planFile?.name ?? 'Upload plan'}
                </Button>
                <input
                  ref={planInputRef}
                  aria-label="Upload code-generation plan"
                  className="sr-only"
                  type="file"
                  accept=".md,text/markdown,text/plain"
                  disabled={submitting}
                  onChange={(event) => setPlanFile(event.target.files?.[0] ?? null)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => summaryInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  {summaryFile?.name ?? 'Upload summary'}
                </Button>
                <input
                  ref={summaryInputRef}
                  aria-label="Upload code summary"
                  className="sr-only"
                  type="file"
                  accept=".md,text/markdown,text/plain"
                  disabled={submitting}
                  onChange={(event) => setSummaryFile(event.target.files?.[0] ?? null)}
                />
                <Button
                  size="sm"
                  disabled={submitting || !planFile || !summaryFile || !onSubmit}
                  onClick={async () => {
                    if (!planFile || !summaryFile || !onSubmit) return;
                    setSubmitting(true);
                    setError(null);
                    try {
                      await onSubmit(gate, {
                        'code-generation-plan': {
                          content: await planFile.text(),
                        },
                        'code-summary': {
                          content: await summaryFile.text(),
                        },
                      });
                    } catch (submitError) {
                      setError(
                        submitError instanceof Error ? submitError.message : 'Submission failed',
                      );
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  <Send className="h-4 w-4" />
                  {submitting ? 'Submitting...' : 'Submit'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {(gate.externalDevelopment?.validationFindings?.length ?? 0) > 0 && (
          <ul className="space-y-1 text-xs text-destructive">
            {gate.externalDevelopment?.validationFindings?.map((finding, index) => (
              <li key={`${finding.field}-${finding.code}-${index}`}>
                {finding.field}: {finding.detail || finding.code}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
