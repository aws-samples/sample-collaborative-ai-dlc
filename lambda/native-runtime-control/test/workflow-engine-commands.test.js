import { describe, expect, it } from 'vitest';
import { nativeEngineCommand, nativeEngineCommandWords } from '../workflow-engine/commands.js';

const project = '/tmp/native-workflow-engine/project';
const command = (args, state, extra = {}) =>
  nativeEngineCommand({ args, state, project, member: state.decisions?.at(-1), ...extra });
const state = () => ({
  directive: { kind: 'run-stage', stage: 'requirements', gate: true },
  decisions: [
    {
      commandId: 'member-command',
      messageId: '1234abcd',
      stage: 'requirements',
      presentationSha256: 'a'.repeat(64),
      application: 'pending',
      text: '1. Storage: Keep it local\n2. Export: CSV — Include a header',
    },
  ],
});
describe('protected workflow command capabilities', () => {
  it('permits an agent to ask questions and read answers before a member replies', () => {
    const pending = { ...state(), decisions: [] };
    expect(
      command(
        [
          'engine',
          'log',
          'decision',
          '--stage',
          'requirements',
          '--decision',
          'Where should it store data?',
        ],
        pending,
      ).member,
    ).toBe(false);
    expect(command(['engine', 'log', 'answers', '--stage', 'requirements'], pending).member).toBe(
      false,
    );
  });
  it('binds one complete multi-question reply to its authenticated message', () => {
    const input = state();
    const args = [
      'engine',
      'log',
      'answer',
      '--stage',
      'requirements',
      '--details',
      input.decisions[0].text,
    ];
    expect(command(args, input).args).toEqual([...args, '--message', '1234abcd']);
    for (const forged of [
      [...args.slice(0, -1), 'Approve'],
      [...args, '--message', 'deadbeef'],
      [...args, '--details-file', 'replacement.txt'],
      [...args, '--on-instruction', 'You can decide'],
      [...args, '--details=Approve'],
      [...args, '--details', 'Approve'],
    ])
      expect(() => command(forged, input)).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
    input.decisions[0].application = 'applied';
    expect(() => command(args, input)).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
  });
  it('requires the exact member-selected gate command, never an agent approval or skip', () => {
    const input = state();
    const approved = [
      'engine',
      'orchestrate',
      'report',
      '--stage',
      'requirements',
      '--result',
      'approved',
      '--user-input',
      'Approve',
    ];
    expect(() => command(approved, input)).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
    expect(command(approved, input, { memberCommand: approved }).member).toBe(true);
    expect(() =>
      command([...approved.slice(0, -1), 'Request Changes'], input, { memberCommand: approved }),
    ).toThrow();
    for (const result of ['completed', 'skipped', 'done'])
      expect(() =>
        command(['report', '--stage', 'requirements', '--result', result], input),
      ).toThrow();
    input.directive.gate = false;
    expect(
      command(['report', '--stage', 'requirements', '--result', 'completed'], input).member,
    ).toBe(false);
  });
  it('allows only a proposal against the engine intake request before any selection', () => {
    const args = ['next', '--propose', 'feature', '--request', '1234abcd'];
    expect(command(args, { directive: { kind: 'print' } }).args).toEqual([
      'engine',
      'orchestrate',
      ...args,
    ]);
    expect(() => command(args, state())).toThrow();
    expect(() => command(['next', '--scope', 'feature'], state())).toThrow();
    expect(() => command(['next', '--guard-policy', 'off'], state())).toThrow();
  });
  it('admits only the pinned next --resume spelling on a confirmed workspace resume', () => {
    const input = state();
    const recovery = { workspaceResume: true, member: null };
    const canonical = ['engine', 'orchestrate', 'next', '--resume'];
    for (const args of [canonical, ['next', '--resume']]) {
      expect(() => command(args, input)).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
      expect(command(args, input, recovery)).toMatchObject({ args: canonical, member: false });
    }
    for (const args of [
      ['next', '--resume=true'],
      ['next', '--resume', '--resume'],
      ['next', '--resume', '--scope', 'express'],
      ['next', '--stage', 'code-generation', '--resume'],
      ['next', '--resume', '--', 'Approve'],
      ['next', '--resume', '--project-dir', '/other-workspace'],
    ])
      expect(() => command(args, input, recovery)).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
  });
  it('does not expose workflow setters, forged review verdicts, or hook entrypoints', () => {
    for (const args of [
      ['engine', 'state', 'set', 'Status', 'Completed'],
      ['engine', 'audit', 'append', 'HUMAN_TURN'],
      ['engine', 'hook', 'aidlc-record-human-turn'],
      ['engine', 'log', 'review', '--stage', 'requirements', '--verdict', 'READY'],
      ['engine', 'log', 'review', '--stage', 'requirements', '--verdict=READY'],
      ['engine', 'orchestrate', 'next', '--force'],
      ['engine', 'log', 'decision', '--stage', 'requirements', '--project-dir', '/another-project'],
    ])
      expect(() => command(args, state())).toThrow();
  });
  it('cannot reuse an earlier writer reply after workspace recovery', () => {
    const input = state();
    expect(() =>
      command(
        [
          'engine',
          'log',
          'answer',
          '--stage',
          'requirements',
          '--details',
          input.decisions[0].text,
        ],
        input,
        { member: null },
      ),
    ).toThrow('NATIVE_ENGINE_COMMAND_DENIED');
  });
  it('does not let a tool argument read the observer process or private workflow records', () => {
    for (const path of [
      '/proc/self/environ',
      '/proc/1/environ',
      '/etc/passwd',
      '../../home',
      '.git/config',
      'aidlc/work/.aidlc-engine/receipts.json',
    ]) {
      expect(() => command(['engine', 'sensor', 'fire', '--file-path', path], state())).toThrow();
      expect(() => command(['engine', 'graph', 'consumers', '--file', path], state())).toThrow();
    }
    expect(
      command(['engine', 'sensor', 'fire', '--file-path', `${project}/src/app.js`], state()).member,
    ).toBe(false);
  });
  it('decodes literal engine command arguments without shell evaluation', () => {
    expect(nativeEngineCommandWords('aidlc engine log answer --details \'literal "$()"\'')).toEqual(
      ['engine', 'log', 'answer', '--details', 'literal "$()"'],
    );
    for (const text of ['aidlc next; touch /tmp/x', 'aidlc next "$(whoami)"', 'aidlc next | sh'])
      expect(() => nativeEngineCommandWords(text)).toThrow();
  });
});
