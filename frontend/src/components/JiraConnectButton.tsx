import { Button } from '@/components/ui/button';

interface Props {
  // Whether the user has an active Jira connection across all of their projects.
  jiraConnected: boolean;
  // Whether the deployment has populated the Jira OAuth secret. When false,
  // the user can't connect — render a disabled button + admin hint.
  jiraConfigured: boolean;
  // Disable the picker button while another binding action is in flight.
  togglingTracker: boolean;
  connectingJira: boolean;
  onConnect: () => void;
  onPickProject: () => void;
}

// Project-level CTA that adapts to the user's Jira connection state and the
// deployment's OAuth-app config. Three modes:
//  - jiraConnected: render "Add Jira project" (opens the picker dialog)
//  - !jiraConfigured: render a disabled "Connect Jira Cloud" + admin hint
//  - default: render "Connect Jira Cloud"
export function JiraConnectButton({
  jiraConnected,
  jiraConfigured,
  togglingTracker,
  connectingJira,
  onConnect,
  onPickProject,
}: Props) {
  if (jiraConnected) {
    return (
      <div className="flex justify-end pt-2">
        <Button size="sm" variant="outline" onClick={onPickProject} disabled={togglingTracker}>
          Add Jira project
        </Button>
      </div>
    );
  }
  if (!jiraConfigured) {
    return (
      <div className="flex flex-col items-end gap-1 pt-2">
        <Button
          size="sm"
          variant="outline"
          disabled
          title="Jira Cloud OAuth credentials are not configured for this deployment."
        >
          Connect Jira Cloud
        </Button>
        <p className="text-[11px] text-muted-foreground max-w-xs text-right">
          Jira Cloud isn’t configured for this deployment. Ask an administrator to add OAuth
          credentials in <strong>Platform Admin → Trackers</strong>.
        </p>
      </div>
    );
  }
  return (
    <div className="flex justify-end pt-2">
      <Button size="sm" variant="outline" onClick={onConnect} disabled={connectingJira}>
        {connectingJira ? 'Connecting…' : 'Connect Jira Cloud'}
      </Button>
    </div>
  );
}
