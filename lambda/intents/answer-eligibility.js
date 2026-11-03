// Who may answer a pending human task. Today every member of the task's space
// may answer, so a task is open to the group rather than assigned to anyone.
// Designated submitters (#589) change this function. Answer and revise
// enforcement is added by #589, which must call this same function from both
// POST …/gates/{id}/answer and POST …/gates/{id}/revise.
export const answerEligibility = ({ membershipRole }) =>
  membershipRole
    ? { eligible: true, basis: 'space-member', assignment: 'open' }
    : { eligible: false, reason: 'not-a-member' };
