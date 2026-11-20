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

// NE-11 J1, publication 1. Display fields and request-bound commands from
// protected snapshot 1b78207c and published interaction 76230cd3.
export const capturedPlanAsk = {
  kind: 'ask',
  ask_type: 'scope-confirm',
  response_route: 'next',
  question:
    'I\'d run the "poc" plan for: "Proof of concept only. Add a pure function clampScore(value, min, max) in a new file \nsrc/clamp-score.js and one test for it in \ntests/clamp-score.test.js that runs with node --test. Do not change any existing file. Keep every document shor..." - 4 stages, 4 approval gates. Do you want me to go ahead with it, use a different plan, or tailor one to this task?',
  proposed_scope: 'poc',
  confirm_command: 'aidlc engine orchestrate next --scope poc --request 6b26fb88',
  compose_command: 'aidlc engine orchestrate next compose --request 6b26fb88',
  scope_commands: [
    {
      command: 'aidlc engine orchestrate next --scope bugfix --request 6b26fb88',
      scope: 'bugfix',
      stages: '5 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope classic --request 6b26fb88',
      scope: 'classic',
      stages: '14 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope enterprise --request 6b26fb88',
      scope: 'enterprise',
      stages: '29 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope express --request 6b26fb88',
      scope: 'express',
      stages: '6 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope feature --request 6b26fb88',
      scope: 'feature',
      stages: '29 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope infra --request 6b26fb88',
      scope: 'infra',
      stages: '10 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope mvp --request 6b26fb88',
      scope: 'mvp',
      stages: '19 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope poc --request 6b26fb88',
      scope: 'poc',
      stages: '4 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope refactor --request 6b26fb88',
      scope: 'refactor',
      stages: '6 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope security-patch --request 6b26fb88',
      scope: 'security-patch',
      stages: '6 stages',
    },
    {
      command: 'aidlc engine orchestrate next --scope workshop --request 6b26fb88',
      scope: 'workshop',
      stages: '22 stages',
    },
  ],
  choices: [
    {
      command: 'aidlc engine orchestrate next --scope poc --request 6b26fb88',
      label: 'Go ahead with the "poc" plan',
    },
    {
      label: 'Use a different plan',
    },
    {
      command: 'aidlc engine orchestrate next compose --request 6b26fb88',
      label: 'Tailor a plan to this task',
    },
  ],
};

export const capturedPlanFormSpec = {
  version: 2,
  questions: [
    {
      prompt:
        'I\'d run the "poc" plan for: "Proof of concept only. Add a pure function clampScore(value, min, max) in a new file src/clamp-score.js and one test for it in tests/clamp-score.test.js that runs with node --test. Do not change any existing file. Keep every document short." - 4 stages, 4 approval gates. Do you want me to go ahead with it, use a different plan, or tailor one to this task?',
      options: capturedPlanAsk.choices.map(({ label }) => ({ label })),
    },
  ],
};
