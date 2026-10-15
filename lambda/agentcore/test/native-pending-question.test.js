import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearNativePendingSpec,
  nativeGateFromSnapshot,
  readNativePendingSpec,
} from '../native/executor.js';

const state = (lines) => Buffer.from(lines.join('\n'));
const snapshot = (stateLines, space = 'default', intent = 'pipes') => ({
  files: [
    { path: 'aidlc/active-space', content: Buffer.from(`${space}\n`) },
    { path: `aidlc/spaces/${space}/intents/active-intent`, content: Buffer.from(`${intent}\n`) },
    { path: `aidlc/spaces/${space}/intents/${intent}/aidlc-state.md`, content: state(stateLines) },
  ],
});

describe('native engine gate detection', () => {
  it('finds the current stage held at [?] awaiting approval', () => {
    const gate = nativeGateFromSnapshot(
      snapshot([
        '- **Current Stage**: requirements-analysis',
        '- [x] workspace-detection — EXECUTE',
        '- [?] requirements-analysis — EXECUTE',
      ]),
    );
    expect(gate).toEqual({ stage: 'requirements-analysis' });
  });
  it('ignores running, revising, other-stage and ambiguous states', () => {
    for (const lines of [
      ['- **Current Stage**: requirements-analysis', '- [-] requirements-analysis — EXECUTE'],
      ['- **Current Stage**: requirements-analysis', '- [R] requirements-analysis — EXECUTE'],
      ['- **Current Stage**: requirements-analysis', '- [?] user-stories — EXECUTE'],
      ['- **Current Stage**: a', '- **Current Stage**: b', '- [?] a — EXECUTE'],
      ['no stage'],
    ]) {
      expect(nativeGateFromSnapshot(snapshot(lines))).toBeNull();
    }
    expect(nativeGateFromSnapshot(snapshot(['- **Current Stage**: x'], '../escape'))).toBeNull();
  });
});

describe('reserved rendered-question spec file', () => {
  it('is cleared before a turn, read once without following links, and removed', async () => {
    const project = await mkdtemp(join(tmpdir(), 'native-spec-'));
    await mkdir(join(project, '.native-control'));
    await writeFile(
      join(project, '.native-control/pending-question.json'),
      '{"version":1,"questions":[]}',
    );
    await clearNativePendingSpec(project);
    expect(await readdir(join(project, '.native-control'))).toEqual([]);
    await writeFile(
      join(project, '.native-control/pending-question.json'),
      '{"version":1,"questions":[]}',
    );
    expect(await readNativePendingSpec(project)).toMatchObject({
      spec: { version: 1, questions: [] },
      bytes: 28,
      reason: null,
    });
    expect(await readdir(join(project, '.native-control'))).toEqual([]);
    expect(await readNativePendingSpec(project)).toMatchObject({ spec: null, reason: 'absent' });
  });
  it('refuses symlinked files and directories and oversized or invalid JSON', async () => {
    const project = await mkdtemp(join(tmpdir(), 'native-spec-'));
    const outside = await mkdtemp(join(tmpdir(), 'native-secret-'));
    await writeFile(join(outside, 'pending-question.json'), '{"version":1,"questions":[]}');
    await symlink(outside, join(project, '.native-control'));
    await expect(readNativePendingSpec(project)).rejects.toMatchObject({
      code: 'native_execution_question_spec_unsafe',
    });
    await clearNativePendingSpec(project); // replaces the link with a real directory
    await symlink(
      join(outside, 'pending-question.json'),
      join(project, '.native-control/pending-question.json'),
    );
    await expect(readNativePendingSpec(project)).rejects.toMatchObject({
      code: 'native_execution_question_spec_unsafe',
    });
    await writeFile(join(project, '.native-control/pending-question.json'), 'x'.repeat(70 * 1024));
    expect(await readNativePendingSpec(project)).toMatchObject({ spec: null, reason: 'too_large' });
    await writeFile(join(project, '.native-control/pending-question.json'), '{not json');
    expect(await readNativePendingSpec(project)).toMatchObject({
      spec: null,
      reason: 'invalid_json',
    });
    await writeFile(join(project, '.native-control/pending-question.json'), 'null');
    expect(await readNativePendingSpec(project)).toMatchObject({ spec: null, reason: null });
    expect(await readdir(outside)).toEqual(['pending-question.json']);
  });
});

describe('display rejection and secret/path boundaries stay separate', () => {
  it.each([
    JSON.stringify({ unexpected: 'fixture-secret' }),
    JSON.stringify({
      version: 2,
      questions: [{ prompt: 'fixture-', header: 'secret', options: [] }],
    }),
    '{broken "fixture-secret"',
  ])('rejects known credential bytes even in invalid or split display data', async (content) => {
    const project = await mkdtemp(join(tmpdir(), 'native-spec-secret-'));
    await clearNativePendingSpec(project);
    await writeFile(join(project, '.native-control/pending-question.json'), content);
    await expect(
      readNativePendingSpec(project, { forbiddenBytes: ['fixture-secret'] }),
    ).rejects.toMatchObject({ code: 'native_execution_output_credential' });
    expect(await readdir(join(project, '.native-control'))).toEqual([]);
  });
  it('does not allow a failing diagnostic callback to turn an unsafe link into a usable form', async () => {
    const project = await mkdtemp(join(tmpdir(), 'native-spec-diagnostic-'));
    await clearNativePendingSpec(project);
    await symlink('/unread-private-target', join(project, '.native-control/pending-question.json'));
    await expect(
      readNativePendingSpec(project, {
        onDiagnostic: () => {
          throw Error('sink down');
        },
      }),
    ).rejects.toMatchObject({ code: 'native_execution_question_spec_unsafe' });
  });
});
