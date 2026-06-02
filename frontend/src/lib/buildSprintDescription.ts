import type { TrackerComment, TrackerIssue } from '@/services/trackers';

// Build the markdown body that becomes Sprint.description when a sprint is
// started from a tracker issue. Provider-agnostic — operates on the
// normalized TrackerIssue + TrackerComment[] shapes.
export const buildSprintDescription = (issue: TrackerIssue, comments: TrackerComment[]): string => {
  const head = `# ${issue.title}\n\n${issue.body ?? ''}`.trimEnd();
  if (comments.length === 0) return head;
  const formatted = comments
    .map((c) => {
      const when = new Date(c.createdAt).toISOString().split('T')[0];
      return `### @${c.author.handle} — ${when}\n\n${c.body.trim()}`;
    })
    .join('\n\n');
  const plural = comments.length === 1 ? '' : 's';
  return `${head}\n\n---\n\n## Discussion (${comments.length} comment${plural})\n\n${formatted}`;
};
