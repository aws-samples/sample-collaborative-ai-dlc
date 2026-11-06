import { nativeInputSnapshot } from '../native-inputs.js';
import { describe, expect, it } from 'vitest';
import { nativeRuntimeCommand } from '../native-runtime-command.js';

const identity = {
  projectId: 'project',
  executionId: 'execution',
  bindingId: 'binding',
  attemptId: 'attempt',
  epoch: 1,
  runtimeSessionId: 'session',
  writerGeneration: 1,
};
const turn = {
  ...identity,
  schemaVersion: 2,
  sequence: 1,
  configuration: {
    harness: 'codex',
    recoveryMode: 'efs-workspace-v1',
    model: null,
    prompt: 'Opaque request fixture',
    packageVersion: '2.11.1',
    inputs: nativeInputSnapshot({ ...identity, request: {} }, 'native-inputs'),
    repository: {
      provider: 'github',
      repository: 'owner/repository',
      branch: 'main',
      commit: 'a'.repeat(40),
    },
  },
  credentials: { model: {}, git: {} },
};
const start = {
  ...turn,
  command: 'native-start',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  package: { candidate: {}, archiveReceipt: {} },
};
const reply = {
  ...turn,
  command: 'native-continue',
  sequence: 2,
  requestId: '10000000-0000-4000-8000-000000000001',
  priorInteractionId: 'c'.repeat(64),
  priorPublicationId: 'd'.repeat(64),
  text: 'An exact member answer.\n',
};
const resume = {
  ...start,
  command: 'native-resume',
  sequence: 2,
  writerGeneration: 2,
  recoveryId: '10000000-0000-4000-8000-000000000002',
};
const current = [
  start,
  reply,
  resume,
  { ...identity, command: 'native-status' },
  { ...identity, command: 'native-activity', after: 0 },
  { ...identity, command: 'native-cancel' },
];
const rejected = { code: 'native_execution_request_invalid' };

describe('current native runtime envelopes', () => {
  it.each(current)('validates $command without replacing its identity or bytes', (command) => {
    const before = structuredClone(command);
    expect(nativeRuntimeCommand(command)).toBe(command);
    expect(command).toEqual(before);
  });

  it.each(current)('rejects extra, missing or foreign ownership fields for $command', (command) => {
    for (const patch of [
      { actorId: 'injected' },
      { checkpoint: {} },
      { executionId: '../another-workspace' },
      { epoch: 2 },
      { writerGeneration: undefined },
      { writerGeneration: 0 },
    ]) {
      expect(() => nativeRuntimeCommand({ ...command, ...patch })).toThrow(
        expect.objectContaining(rejected),
      );
    }
  });

  it.each([start, reply, resume])('rejects old or unpinned turn fields for $command', (command) => {
    for (const patch of [
      { schemaVersion: 1 },
      { sequence: undefined },
      { sequence: '1' },
      { configuration: { ...turn.configuration, recoveryMode: 'snapshot-v1' } },
      { configuration: { ...turn.configuration, approved: true } },
      {
        configuration: {
          ...turn.configuration,
          repository: { ...turn.configuration.repository, token: 'injected' },
        },
      },
      { credentials: null },
    ]) {
      expect(() => nativeRuntimeCommand({ ...command, ...patch })).toThrow(
        expect.objectContaining(rejected),
      );
    }
  });

  it.each([
    { ...start, sequence: 2 },
    { ...start, writerGeneration: 2 },
    { ...start, imageDigest: 'latest' },
    { ...start, package: { candidate: {}, archiveReceipt: {}, checkpoint: {} } },
    { ...reply, package: start.package },
    { ...reply, text: 'answer\u0000' },
    { ...reply, text: 'answer\ud800' },
    { ...reply, text: ' ' },
    { ...reply, text: '🟦'.repeat(4097) },
    { ...reply, requestId: 'client-request-alias' },
    { ...reply, priorInteractionId: 'unknown' },
    { ...resume, text: reply.text },
    { ...resume, requestId: reply.requestId },
    { ...resume, writerGeneration: 1 },
    { ...resume, recoveryId: 'old-episode' },
    { ...resume, command: 'native-recover' },
    { ...identity, command: 'native-activity', after: -1 },
  ])('rejects a conflicting or retired command envelope %#', (command) => {
    expect(() => nativeRuntimeCommand(command)).toThrow(expect.objectContaining(rejected));
  });
});
