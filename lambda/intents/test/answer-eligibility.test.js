import { describe, it, expect } from 'vitest';
import { answerEligibility } from '../answer-eligibility.js';
describe('answerEligibility', () => {
  it.each(['owner', 'admin', 'member'])('opens the task to a %s', (membershipRole) => {
    expect(answerEligibility({ userId: 'u1', membershipRole, projectId: 'p1' })).toEqual({
      eligible: true,
      basis: 'space-member',
      assignment: 'open',
    });
  });
  it('refuses a non-member', () => {
    expect(answerEligibility({ userId: 'u1', membershipRole: null, projectId: 'p1' })).toEqual({
      eligible: false,
      reason: 'not-a-member',
    });
  });
});
