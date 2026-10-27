import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeNativeWorkflowResumeState } from '../native/workflow-resume-state.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const state = `# AI-DLC State Tracking

## Project Information
- **Project**: Offline fixture
- **Scope**: feature
- **State Version**: 8

## Scope Configuration
- **Plan Approval**: on (from scope feature)

## Workspace State
- **Project Root**: .

## Execution Plan Summary
- **Total Stages**: 4

## Runtime State
- **Revision Count**: 0

## Phase Progress
- **Ideation**: Active

## Stage Progress
### INITIALIZATION PHASE
- [x] state-init — EXECUTE
### IDEATION PHASE
- [-] feasibility — EXECUTE

## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Status**: Running
- **Last Updated**: 2026-10-26T12:00:00Z

## Session Resume Point
- **Next Action**: Execute feasibility
- **Pending Artifacts**: none
`;
const entry = {
  uuid: '019a0010-7a11-7000-8000-000000000010',
  slug: 'fixture',
  dirName: '261026-fixture',
  scope: 'feature',
  status: 'in-flight',
};

async function fixture({ created = false, space = 'default' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-workflow-resume-')));
  roots.push(root);
  const project = join(root, 'project');
  const roof = join(project, 'aidlc');
  const intents = join(roof, 'spaces', space, 'intents');
  const record = join(intents, entry.dirName);
  await fs.mkdir(intents, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(roof, 'active-space'), `${space}\n`);
  const result = {
    root,
    project,
    roof,
    intents,
    record,
    statePath: join(record, 'aidlc-state.md'),
    registryPath: join(intents, 'intents.json'),
    pointerPath: join(intents, 'active-intent'),
    observe: (io) => observeNativeWorkflowResumeState({ project, ...(io ? { io } : {}) }),
    async create(text = state) {
      await fs.mkdir(record, { recursive: true });
      await fs.writeFile(join(record, 'aidlc-state.md'), text);
      await fs.writeFile(join(intents, 'intents.json'), JSON.stringify([entry]));
      await fs.writeFile(join(intents, 'active-intent'), `${entry.dirName}\n`);
    },
  };
  if (created) await result.create();
  return result;
}

describe('observeNativeWorkflowResumeState', () => {
  it('recognizes configured intake without inventing an active workflow', async () => {
    const f = await fixture();
    await fs.mkdir(join(f.intents, '.aidlc-engine'));
    await fs.writeFile(
      join(f.intents, '.aidlc-engine', 'intake-question.json'),
      '{"pending":true}',
    );
    expect(await f.observe()).toBe('not_created');
    await fs.writeFile(f.registryPath, '[]\n');
    expect(await f.observe()).toBe('not_created');
    await fs.rm(f.intents, { recursive: true });
    expect(await f.observe()).toBe('not_created');
  });

  it('uses the current selected space and a committed created record', async () => {
    const f = await fixture({ created: true, space: 'product-team' });
    expect(await f.observe()).toBe('created');
    const before = await fs.readFile(f.statePath);
    expect(await f.observe()).toBe('created');
    expect(await fs.readFile(f.statePath)).toEqual(before);
  });

  it('observes creation after an earlier published intake boundary', async () => {
    const f = await fixture();
    const published = join(f.root, 'published');
    await fs.cp(f.project, published, { recursive: true });
    expect(await f.observe()).toBe('not_created');
    await f.create();
    expect(await observeNativeWorkflowResumeState({ project: published })).toBe('not_created');
    expect(await f.observe()).toBe('created');
    await fs.rm(f.statePath);
    expect(await f.observe()).toBe('unavailable');
  });

  it('leaves stage gates, completion and registry lifecycle decisions to the engine', async () => {
    const f = await fixture({ created: true });
    for (const [checkbox, status] of [
      ['?', 'Awaiting Approval'],
      ['R', 'Revising'],
      ['x', 'Completed'],
    ]) {
      await fs.writeFile(
        f.statePath,
        state
          .replace('[-]', `[${checkbox}]`)
          .replace('**Status**: Running', `**Status**: ${status}`),
      );
      await fs.writeFile(
        f.registryPath,
        JSON.stringify([{ ...entry, status: status === 'Completed' ? 'complete' : 'in-flight' }]),
      );
      expect(await f.observe()).toBe('created');
    }
  });

  it('fails closed throughout interrupted creation instead of calling a partial record intake', async () => {
    const f = await fixture();
    await fs.mkdir(f.record);
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.statePath, '# AI-DLC State Tracking\n');
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.statePath, state);
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.registryPath, JSON.stringify([entry]));
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.pointerPath, entry.dirName);
    expect(await f.observe()).toBe('created');
  });

  it.each(['', '../elsewhere', '/tmp/elsewhere', 'default\nanother', ' default', 'default '])(
    'rejects invalid active-space pointer %j',
    async (value) => {
      const f = await fixture({ created: true });
      await fs.writeFile(join(f.roof, 'active-space'), value);
      expect(await f.observe()).toBe('unavailable');
    },
  );

  it.each(['', '../elsewhere', '/tmp/elsewhere', 'missing-record', `${entry.dirName}\nother`])(
    'rejects invalid or dangling active-intent pointer %j',
    async (value) => {
      const f = await fixture({ created: true });
      await fs.writeFile(f.pointerPath, value);
      expect(await f.observe()).toBe('unavailable');
    },
  );

  it('does not use a default space or lone-record fallback after a pointer is lost', async () => {
    const f = await fixture({ created: true });
    await fs.rm(f.pointerPath);
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.pointerPath, entry.dirName);
    await fs.rm(join(f.roof, 'active-space'));
    expect(await f.observe()).toBe('unavailable');
  });

  it.each([
    '',
    '{}',
    '[{"uuid":',
    '<<<<<<< ours\n[]\n=======\n[]\n>>>>>>> theirs\n',
    JSON.stringify([entry, entry]),
    JSON.stringify([entry, { ...entry, uuid: '019a0010-7a11-7000-8000-000000000011' }]),
    JSON.stringify([{ ...entry, uuid: 'invalid' }]),
    JSON.stringify([{ ...entry, scope: 8 }]),
    JSON.stringify([{ ...entry, status: 'unknown' }]),
    JSON.stringify([{ ...entry, dirName: '../elsewhere' }]),
    JSON.stringify([{ ...entry, scope: 'poc' }]),
    '[]',
  ])('rejects corrupt, ambiguous or mismatched registry %j', async (text) => {
    const f = await fixture({ created: true });
    await fs.writeFile(f.registryPath, text);
    expect(await f.observe()).toBe('unavailable');
  });

  it.each([
    '',
    '# AI-DLC State Tracking\n',
    state.slice(0, state.indexOf('## Current Status')),
    state.slice(0, state.indexOf('- **Pending Artifacts**')),
    state.replace('**State Version**: 8', '**State Version**: 7'),
    state.replace('**State Version**: 8', '**State Version**: 9'),
    state.replace('**State Version**: 8', '**State Version**: 8\n- **State Version**: 8'),
    state.replace('**Current Stage**: feasibility', '**Current Stage**:'),
    state.replace('**Scope**: feature', '**Scope**: poc'),
    state.replace('## Current Status', '## Current Status\n<<<<<<< ours'),
    state.replace('Offline fixture', 'Offline\u0000fixture'),
    Buffer.from([0xff, 0xfe, 0xfd]),
  ])('rejects incomplete, incompatible or ambiguous state %#', async (text) => {
    const f = await fixture({ created: true });
    await fs.writeFile(f.statePath, text);
    expect(await f.observe()).toBe('unavailable');
  });

  it.each([
    'aidlc',
    'aidlc/active-space',
    'aidlc/spaces',
    'aidlc/spaces/default',
    'aidlc/spaces/default/intents',
    `aidlc/spaces/default/intents/${entry.dirName}`,
    'aidlc/spaces/default/intents/active-intent',
    'aidlc/spaces/default/intents/intents.json',
    `aidlc/spaces/default/intents/${entry.dirName}/aidlc-state.md`,
  ])('does not follow the linked metadata path %s', async (relative) => {
    const f = await fixture({ created: true });
    const path = join(f.project, relative);
    const outside = join(f.root, 'outside');
    await fs.rename(path, outside);
    await fs.symlink(outside, path);
    expect(await f.observe()).toBe('unavailable');
  });

  it('rejects links in intake metadata and hardlinked metadata files', async () => {
    const f = await fixture();
    await fs.mkdir(join(f.root, 'outside'));
    await fs.symlink(join(f.root, 'outside'), join(f.intents, '.aidlc-engine'));
    expect(await f.observe()).toBe('unavailable');
    await fs.rm(join(f.intents, '.aidlc-engine'));
    await f.create();
    for (const path of [f.pointerPath, f.registryPath, f.statePath]) {
      const link = join(f.root, 'hardlink');
      await fs.link(path, link);
      expect(await f.observe()).toBe('unavailable');
      await fs.rm(link);
    }
  });

  it('rejects a FIFO without opening it or blocking', async () => {
    const f = await fixture({ created: true });
    await fs.rm(f.statePath);
    execFileSync('mkfifo', [f.statePath]);
    let opens = 0;
    expect(
      await f.observe({
        ...fs,
        open: async (...args) => {
          if (args[0] === f.statePath) opens++;
          return fs.open(...args);
        },
      }),
    ).toBe('unavailable');
    expect(opens).toBe(0);
  });

  it('bounds metadata before reading and never traverses the application tree', async () => {
    const f = await fixture({ created: true });
    await fs.writeFile(f.statePath, Buffer.alloc(1024 * 1024 + 1, 'x'));
    expect(await f.observe()).toBe('unavailable');
    await fs.writeFile(f.statePath, state);
    const reads = [];
    const io = {
      ...fs,
      open: async (path, ...args) => {
        reads.push(path);
        return fs.open(path, ...args);
      },
      opendir: async () => {
        throw new Error('Created records require no directory listing');
      },
    };
    await fs.symlink('/never-follow-application-dependencies', join(f.project, 'node_modules'));
    expect(await f.observe(io)).toBe('created');
    expect(reads).toHaveLength(4);
    expect(reads.every((path) => path.startsWith(`${f.roof}/`))).toBe(true);
  });

  it('rejects oversized pointer and registry files before opening them', async () => {
    const f = await fixture({ created: true });
    for (const [path, size] of [
      [f.pointerPath, 258],
      [f.registryPath, 256 * 1024 + 1],
    ]) {
      const original = await fs.readFile(path);
      await fs.writeFile(path, Buffer.alloc(size, 'a'));
      let opened = false;
      expect(
        await f.observe({
          ...fs,
          open: async (target, ...args) => {
            if (target === path) opened = true;
            return fs.open(target, ...args);
          },
        }),
      ).toBe('unavailable');
      expect(opened).toBe(false);
      await fs.writeFile(path, original);
    }
  });

  it('does not call a missing registry intake when an active record is selected', async () => {
    const f = await fixture({ created: true });
    await fs.rm(f.registryPath);
    expect(await f.observe()).toBe('unavailable');
  });

  it('refuses a pointer replacement during observation', async () => {
    const f = await fixture({ created: true });
    const io = {
      ...fs,
      open: async (path, ...args) => {
        const file = await fs.open(path, ...args);
        if (path === f.statePath) await fs.writeFile(f.pointerPath, '261026-other');
        return file;
      },
    };
    expect(await f.observe(io)).toBe('unavailable');
  });

  it('refuses same-length state replacement during a bounded read', async () => {
    const f = await fixture({ created: true });
    const io = {
      ...fs,
      open: async (path, ...args) => {
        const file = await fs.open(path, ...args);
        if (path !== f.statePath) return file;
        const original = file.read.bind(file);
        file.read = async (...readArgs) => {
          const result = await original(...readArgs);
          await fs.writeFile(path, state.replace('feature', 'changed'));
          return result;
        };
        return file;
      },
    };
    expect(await f.observe(io)).toBe('unavailable');
  });

  it('rejects unsafe project roots and unexpected I/O errors without disclosing details', async () => {
    const f = await fixture({ created: true });
    expect(await observeNativeWorkflowResumeState()).toBe('unavailable');
    expect(await observeNativeWorkflowResumeState({ project: 'relative' })).toBe('unavailable');
    await fs.symlink(f.project, join(f.root, 'project-link'));
    expect(await observeNativeWorkflowResumeState({ project: join(f.root, 'project-link') })).toBe(
      'unavailable',
    );
    expect(
      await f.observe({
        ...fs,
        open: async () => {
          throw new Error('private bytes must not escape');
        },
      }),
    ).toBe('unavailable');
    await fs.chmod(f.project, 0o755);
    expect(await f.observe()).toBe('unavailable');
  });
});
