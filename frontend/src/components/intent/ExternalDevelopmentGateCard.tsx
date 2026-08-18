import { useState } from 'react';
import { Download, RotateCcw, Send, Upload } from 'lucide-react';
import type { GateAnswer, IntentGate, NativeHandoffDocuments } from '@/services/intents';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface ExternalDevelopmentGateCardProps {
  gate: IntentGate;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
  onExport?: (gate: IntentGate) => Promise<void>;
  onSubmit?: (gate: IntentGate, documents: NativeHandoffDocuments) => Promise<void>;
}

export function ExternalDevelopmentGateCard({
  gate,
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

  return (
    <Card>
      <CardContent className="space-y-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {gate.unitSlug && (
            <Badge variant="outline" className="px-1.5 py-0 text-[9px] font-normal">
              unit {gate.unitSlug}
            </Badge>
          )}
          {gate.externalDevelopment?.harness && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[9px] font-normal">
              {gate.externalDevelopment.harness}
            </Badge>
          )}
        </div>
        <p className="text-sm font-medium">External code generation</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={exporting || !onExport}
            onClick={async () => {
              if (!onExport) return;
              setExporting(true);
              try {
                await onExport(gate);
              } finally {
                setExporting(false);
              }
            }}
          >
            <Download className="h-4 w-4" />
            {exporting ? 'Preparing workspace...' : 'Download workspace'}
          </Button>
          <Button asChild size="sm" variant="outline">
            <label>
              <Upload className="h-4 w-4" />
              {planFile?.name ?? 'Select plan'}
              <input
                className="sr-only"
                type="file"
                accept=".md,text/markdown,text/plain"
                onChange={(event) => setPlanFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </Button>
          <Button asChild size="sm" variant="outline">
            <label>
              <Upload className="h-4 w-4" />
              {summaryFile?.name ?? 'Select summary'}
              <input
                className="sr-only"
                type="file"
                accept=".md,text/markdown,text/plain"
                onChange={(event) => setSummaryFile(event.target.files?.[0] ?? null)}
              />
            </label>
          </Button>
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
                setError(submitError instanceof Error ? submitError.message : 'Submission failed');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <Send className="h-4 w-4" />
            {submitting ? 'Submitting...' : 'Submit'}
          </Button>
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
