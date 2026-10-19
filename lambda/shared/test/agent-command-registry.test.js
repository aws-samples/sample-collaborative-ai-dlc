import { describe, expect, it } from 'vitest';
import { COMMANDS, GRANT_SCOPES } from '../agent-command-registry.js';
import { gatewayScopeForCommand } from '../gateway-grant.js';

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
        'inspect',
        'init-lane',
        'merge-lane',
        'reconcile-lane',
        'refresh-intent',
      ].toSorted(),
    );
  });

  it('keeps commands that touch no execution data grant-free', () => {
    const none = Object.entries(COMMANDS)
      .filter(([, definition]) => definition.grantScope === GRANT_SCOPES.NONE)
      .map(([name]) => name)
      .toSorted();
    expect(none).toEqual(
      ['capabilities', 'managed-runtime-check', 'verify-mcp', 'verify-connection'].toSorted(),
    );
  });
  it('issues execution authority for refresh-intent repository access', () => {
    expect(
      gatewayScopeForCommand(
        { command: 'refresh-intent' },
        {
          projectId: 'p',
          intentId: 'i',
          executionId: 'e',
        },
      ),
    ).toEqual({ mode: 'execution', projectId: 'p', intentId: 'i', executionId: 'e' });
  });
});
