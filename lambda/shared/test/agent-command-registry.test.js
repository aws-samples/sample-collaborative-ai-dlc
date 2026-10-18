import { describe, expect, it } from 'vitest';
import { COMMANDS, GRANT_SCOPES } from '../agent-command-registry.js';

describe('agent command registry', () => {
  it('declares a valid Gateway grant scope for every command', () => {
    const scopes = new Set(Object.values(GRANT_SCOPES));
    for (const [name, definition] of Object.entries(COMMANDS)) {
      expect(scopes.has(definition.grantScope), `${name} grantScope`).toBe(true);
    }
  });

  it('grants stage, conflict and discussion scopes only to the commands that use them', () => {
    const byScope = (scope) =>
      Object.entries(COMMANDS)
        .filter(([, definition]) => definition.grantScope === scope)
        .map(([name]) => name)
        .toSorted();
    expect(byScope(GRANT_SCOPES.STAGE)).toEqual(['run-stage', 'run-stage-start']);
    expect(byScope(GRANT_SCOPES.CONFLICT)).toEqual(['resolve-conflict']);
    expect(byScope(GRANT_SCOPES.DISCUSSION)).toEqual(['discussion-assist-start']);
    expect(byScope(GRANT_SCOPES.EXECUTION)).toEqual(
      [
        'init-ws',
        'promote-units',
        'create-workflow-checkpoint',
        'record-pr',
        'record-learning',
        'record-unit-pr',
        'derive-artifacts',
        'compose-plan-start',
        'quorum-edit-plan-start',
        'quorum-edit-apply-start',
        'repair-structure',
      ].toSorted(),
    );
  });
});
