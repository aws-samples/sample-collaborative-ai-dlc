// Public AI-DLC 2.11.1 scopeConfirmAskDirective contract, with synthetic request
// and task data. Runtime archive SHA256:
// 9f213c8254e646123b3f4bcefe347a61c95c72fee9fda4bf9afab42ccb20f44a.
// This is not the unavailable sidecar of any live execution.
export const proposedPlanSpec = {
  version: 3,
  ask: {
    kind: 'ask',
    ask_type: 'scope-confirm',
    response_route: 'next',
    question: 'Use the proposed plan, choose another plan, or tailor one?',
    proposed_scope: 'bugfix',
    confirm_command: 'aidlc engine orchestrate next --scope bugfix --request fixture-request',
    compose_command: 'aidlc engine orchestrate next compose --request fixture-request',
    scope_commands: [
      {
        scope: 'bugfix',
        stages: '3 stages',
        command: 'aidlc engine orchestrate next --scope bugfix --request fixture-request',
      },
      {
        scope: 'classic',
        stages: '12 stages',
        command: 'aidlc engine orchestrate next --scope classic --request fixture-request',
      },
    ],
    choices: [
      {
        label: 'Go ahead with the "bugfix" plan',
        command: 'aidlc engine orchestrate next --scope bugfix --request fixture-request',
      },
      { label: 'Use a different plan' },
      {
        label: 'Tailor a plan to this task',
        command: 'aidlc engine orchestrate next compose --request fixture-request',
      },
    ],
  },
};
