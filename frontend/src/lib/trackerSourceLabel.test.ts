import { describe, expect, it } from 'vitest';
import { formatTrackerSourceLabel } from './trackerSourceLabel';

describe('formatTrackerSourceLabel', () => {
  it('uses numbered issue labels for GitHub and GitLab', () => {
    expect(formatTrackerSourceLabel({ provider: 'github-issues', resourceId: '2' })).toBe(
      'Issue #2',
    );
    expect(formatTrackerSourceLabel({ provider: 'gitlab-issues', resourceId: '3' })).toBe(
      'Issue #3',
    );
  });

  it('keeps Jira resource keys and uses the subtype when available', () => {
    expect(formatTrackerSourceLabel({ provider: 'jira-cloud', resourceId: 'TAS-01' })).toBe(
      'TAS-01',
    );
    expect(
      formatTrackerSourceLabel({
        provider: 'jira-cloud',
        resourceId: 'TAS-01',
        entityType: 'Task',
      }),
    ).toBe('Task TAS-01');
  });
});
