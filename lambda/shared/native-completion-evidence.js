import definition from './native-workflow-policy-data.json' with { type: 'json' };
import { nativeAnswerText, nativeSelection } from './native-pending-input.js';

// A content-addressed definition catalogue, not a workflow engine. These are
// the unamended package defaults only. No filesystem state, version label,
// runtime prose or current global setting can select/amend a plan here.
const recognized = (packageId, harness) =>
  packageId === definition.packageId && harness === definition.harness;
export const nativeWorkflowDefinition = (packageId, harness) =>
  recognized(packageId, harness) ? structuredClone(definition) : null;

export const nativeVerificationSummary = (
  publicationId,
  publicationSequence,
  packageId,
  harness,
) => ({
  publicationId,
  publicationSequence,
  workflowCompletion: 'not_verified',
  requiredChecks: 'not_recorded',
  finalReview: 'not_recorded',
  humanApproval: 'not_recorded',
  policy: 'pinned_workflow',
  requirementsStatus: 'unknown',
  policyStatus: recognized(packageId, harness) ? 'definition_recognized' : 'unsupported',
  reason: recognized(packageId, harness)
    ? 'protected_effective_plan_and_outcomes_unavailable'
    : 'unsupported_package_protocol',
});

// Inputs come only from the immutable interaction and protected RESPONSE
// owners. This attests to a member's selected option for the presented proposal,
// NOT to an engine gate, its applicability, application or terminal outcome.
// Legacy text answers are deliberately not classified, even if they say Approve.
export const nativeMemberDecision = (interaction, response) => {
  const input = interaction?.pendingInput;
  if (!response?.selection || input?.kind !== 'approval') return null;
  const selection = nativeSelection(input, response.selection);
  if (
    nativeAnswerText(input, selection) !== response.text ||
    response.interactionId !== interaction.id ||
    response.contentSha256 !== interaction.contentSha256 ||
    response.sequence !== interaction.sequence + 1
  )
    throw Object.assign(new Error('The recorded member decision could not be verified'), {
      code: 'NATIVE_ARTIFACT_REVISION_INVALID',
    });
  const answer = selection.answers[0];
  if (answer.selectedOptions.length !== 1) return null;
  const label = input.questions[0].options[answer.selectedOptions[0]].label;
  return {
    status: 'recorded',
    origin: 'protected_member_selection',
    commandId: response.commandId,
    interactionId: response.interactionId,
    contentSha256: response.contentSha256,
    sequence: response.sequence,
    actorId: response.actorId,
    acceptedAt: new Date(response.acceptedAt).toISOString(),
    epoch: response.epoch,
    membershipRecorded: Boolean(response.member),
    presentedStage: input.stage,
    label,
    additionalText: Boolean(answer.freeText),
    applicationStatus: 'not_recorded',
  };
};
