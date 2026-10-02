import { Button } from '@/components/ui/button';
import type { AgentAuthAction, AgentAuthImpactReview, AgentAuthModeView } from '@/services/agents';
import { agentAuthProviderUi } from './agent-auth/registry';
import { summarizeConfiguration } from './agent-auth/summary';

const labels: Record<string, string> = {
  continues: 'Continues with existing identity',
  'next-start': 'Uses new configuration on next start',
  'loses-access': 'Next invocation or renewal loses access',
  repair: 'Needs reconnect or credential repair',
  unknown: 'Cannot yet determine',
};

// Describes the normalized candidate the server stored, not what the form sent.
function CandidateDescription({
  candidate,
  modes,
}: {
  candidate: AgentAuthAction;
  modes?: readonly AgentAuthModeView[];
}) {
  if (candidate.kind === 'connection-create') {
    const { connection } = candidate;
    const ui = agentAuthProviderUi(connection.mode);
    const summary = summarizeConfiguration(ui, connection.configuration);
    return (
      <div className="break-all text-xs">
        <p>
          {`Proposed ${connection.source === 'user' ? 'personal' : connection.source} ${ui?.noun ?? 'connection'}`}
        </p>
        {summary.map((line) => (
          <p key={line.label}>
            {line.label}: {line.value}
          </p>
        ))}
      </div>
    );
  }
  if (candidate.kind === 'space-selection' && candidate.connectionId === null)
    return <p className="text-xs">Use the platform connection for new work in this space.</p>;
  if (candidate.kind === 'policy-change')
    return (
      <p className="text-xs">
        Proposed mode: {modes?.find((mode) => mode.id === candidate.mode)?.label ?? candidate.mode}
      </p>
    );
  return null;
}

export function AuthenticationImpactReview({
  review,
  modes,
  applying,
  onApply,
  onCancel,
}: {
  review: AgentAuthImpactReview;
  modes?: readonly AgentAuthModeView[];
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <section aria-label="Authentication change impact" className="space-y-3 rounded-md border p-4">
      <p className="text-sm font-medium">Review authentication change</p>
      <p className="text-xs text-muted-foreground">
        Prepared {new Date(review.createdAt).toLocaleString()} · Configuration revision{' '}
        {review.policyRevision}
      </p>
      {review.candidate && <CandidateDescription candidate={review.candidate} modes={modes} />}
      {review.limitations.map((limitation) => (
        <p key={limitation} className="text-xs text-muted-foreground">
          {limitation}
        </p>
      ))}
      <ul className="space-y-1 text-xs">
        {Object.entries(review.counts).map(([outcome, count]) => (
          <li key={outcome}>
            {labels[outcome] ?? outcome}: {count}
          </li>
        ))}
      </ul>
      <details>
        <summary className="cursor-pointer text-sm">
          Affected spaces and work ({review.items.length})
        </summary>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className="p-2">Space / work</th>
                <th className="p-2">Activity / identity</th>
                <th className="p-2">Effect and action</th>
              </tr>
            </thead>
            <tbody>
              {review.items.map((item) => (
                <tr key={item.key} className="border-t">
                  <td className="p-2">
                    {item.projectId ?? 'Platform'}
                    <br />
                    {item.id}
                  </td>
                  <td className="p-2">
                    {item.status ?? item.type}
                    <br />
                    {item.connectionId ?? 'Selected at next start'}
                  </td>
                  <td className="p-2">
                    <strong>{labels[item.outcome] ?? item.outcome}</strong>
                    <p>{item.reason}</p>
                    <p>{item.action}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onApply} disabled={applying}>
          {applying ? 'Applying…' : 'Apply reviewed change'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
