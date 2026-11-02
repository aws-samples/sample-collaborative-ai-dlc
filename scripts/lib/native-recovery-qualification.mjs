/* eslint-disable unicorn/consistent-function-scoping -- Functions are embedded unchanged in fixed runtime commands. */
import * as filesystem from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeError, requireNfsMount } from './native-efs-probe.mjs';

export const QUALIFICATION_CODES = [
  'invalid_arguments',
  'read_only_profile',
  'account_mismatch',
  'authority_read_failed',
  'authority_mismatch',
  'authority_changed',
  'resource_mismatch',
  'stop_unconfirmed',
  'bootstrap_unconfirmed',
  'runtime_response_invalid',
  'runtime_output_limit',
  'runtime_command_failed',
  'workspace_invalid',
  'not_writable_nfs_mount',
  'barrier_invalid',
  'barrier_not_active',
  'unfinished_files_missing',
  'dependency_links_missing',
  'quarantine_exists',
  'next_writer_exists',
  'active_harness',
  'operation_failed',
];

export const qualificationError = (code) => Object.assign(new Error(code), { code });
export const qualificationCode = (error) =>
  QUALIFICATION_CODES.includes(error?.code) ? error.code : 'operation_failed';

// workspace.json persists String(lstat(..., { bigint: true }).ino). Node can
// expose libuv's uint64 file ID through a signed BigInt64Array. Validate that
// exact representation without Number coercion or rewriting the recorded ID.
export function validWorkspaceInode(value) {
  return (
    typeof value === 'string' &&
    /^(?:0|-?[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) >= -(1n << 63n) &&
    BigInt(value) <= (1n << 64n) - 1n
  );
}

export const WORKSPACE_VALIDATION_CHECKS = [
  'input',
  'directory_read',
  'directory_type',
  'directory_mode',
  'directory_owner',
  'directory_canonical',
  'directory_inode',
  'directory_unchanged',
  'file_open',
  'file_metadata',
  'file_type',
  'file_size',
  'file_owner',
  'file_mode',
  'file_links',
  'file_read',
  'file_unchanged',
  'nfs_mount',
  'workspace_parse',
  'owner_parse',
  'workspace_schema',
  'owner_schema',
  'workspace_identity',
  'owner_identity',
  'owner_writer',
  'owner_configuration',
  'workspace_configuration',
  'workspace_package',
  'workspace_project_inode',
  'workspace_node_identity',
  'next_writer_absent',
  'workspace_unchanged',
  'owner_unchanged',
  'barrier',
  'changed_files',
  'file_canonical',
  'dependency_links',
  'harness_inactive',
  'layout_original_inode',
  'layout_current_inode',
  'layout_children',
  'layout_unchanged',
  'quarantine_absent',
  'quarantine_create',
  'quarantine_rename',
  'quarantine_sync',
  'quarantine_original_inode',
  'replacement_create',
  'replacement_inode',
  'project_absent',
  'complete',
];
export const WORKSPACE_VALIDATION_SUBJECTS = [
  'root',
  'project',
  'machine',
  'control',
  'owner',
  'workspace_record',
  'owner_record',
  'quarantine',
  'quarantined_project',
  'barrier',
  'changed_file',
  'other',
];
export const WORKSPACE_INODE_FIELDS = [
  'root',
  'project',
  'machine',
  'quarantine',
  'quarantined_project',
  'recorded_root',
  'recorded_project',
  'recorded_machine',
];
export const WORKSPACE_FILESYSTEM_CODES = [
  'ENOENT',
  'ENOTDIR',
  'ELOOP',
  'EACCES',
  'EPERM',
  'ESTALE',
  'EIO',
  'ENOSPC',
  'EROFS',
];

// This runs as a real Claude Bash tool, after its implementation edits and
// dependency installation. It neither answers questions nor changes authority.
// A timed-out/missing/dead process is never accepted as an interruption proof.
export async function qualificationBarrier(nonce) {
  const fs = await import('node:fs/promises');
  const { constants: flags } = await import('node:fs');
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce) ||
    process.platform !== 'linux' ||
    (await fs.realpath(process.cwd())) !== '/mnt/native/project'
  )
    throw new Error('Invalid qualification barrier');
  const directory = '/mnt/native/project/.ne02-qualification';
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const node = await fs.lstat(directory);
  if (
    !node.isDirectory() ||
    node.isSymbolicLink() ||
    (node.mode & 0o077) !== 0 ||
    node.uid !== process.getuid() ||
    (await fs.realpath(directory)) !== directory
  )
    throw new Error('Invalid qualification barrier directory');
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const startedAt = Date.now();
  const marker = {
    schemaVersion: 1,
    nonce,
    pid: process.pid,
    ppid: process.ppid,
    startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
    startedAt,
    deadline: startedAt + 150_000,
  };
  const handle = await fs.open(
    `${directory}/${nonce}.json`,
    flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | flags.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await fs.open(directory, flags.O_RDONLY | flags.O_DIRECTORY | flags.O_NOFOLLOW);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 150_000));
}

export function barrierSource(nonce) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(nonce))
    throw qualificationError('invalid_arguments');
  return `(${qualificationBarrier.toString()})(${JSON.stringify(nonce)}).catch(()=>process.exit(1));`;
}

export const barrierCommand = (nonce) =>
  `node --input-type=module -e '${barrierSource(nonce).replaceAll("'", "'\\''")}'`;

// Only tests may substitute the filesystem/mount/process readers. The command
// builder below never serializes these ports, a caller-selected root or code.
export async function runWorkspaceOperation(
  input,
  {
    fs = filesystem,
    root = '/mnt/native',
    procRoot = '/proc',
    now = Date.now,
    kill = process.kill,
    git = promisify(execFile),
    inspectMount,
  } = {},
) {
  let validation = { check: 'input' };
  const inodes = {};
  const checking = (check, subject) => {
    validation = { check, ...(subject ? { subject } : {}) };
  };
  const fail = (code) => {
    throw qualificationError(code);
  };
  const requireCheck = (condition, check, subject) => {
    checking(check, subject);
    if (!condition) fail('workspace_invalid');
  };
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const keys = ['projectId', 'executionId', 'bindingId', 'attemptId', 'epoch', 'runtimeSessionId'];
  const sameIdentity = (value) => keys.every((key) => value?.[key] === input.identity[key]);
  const project = `${root}/project`;
  const control = `${root}/.native-control`;
  const ownerDirectory = `${control}/${input.writerGeneration === 1 ? 'first-turn' : `writer-${input.writerGeneration}`}`;
  const quarantine = `${root}/.ne02-quarantine-${input.nonce}`;
  let quarantined = false;
  const subjectOf = (path) => {
    for (const [subject, expected] of [
      ['root', root],
      ['project', project],
      ['machine', `${root}/machine`],
      ['control', control],
      ['owner', ownerDirectory],
      ['workspace_record', `${control}/workspace.json`],
      ['owner_record', `${ownerDirectory}/owner.json`],
      ['quarantine', quarantine],
      ['quarantined_project', `${quarantine}/project`],
    ])
      if (path === expected) return subject;
    return path.startsWith(`${project}/.ne02-qualification`) ? 'barrier' : 'other';
  };
  const privateDirectory = async (path) => {
    const subject = subjectOf(path);
    checking('directory_read', subject);
    const node = await fs.lstat(path, { bigint: true });
    if (WORKSPACE_INODE_FIELDS.includes(subject) && validWorkspaceInode(String(node.ino)))
      inodes[subject] = String(node.ino);
    requireCheck(node.isDirectory() && !node.isSymbolicLink(), 'directory_type', subject);
    requireCheck((node.mode & 0o077n) === 0n, 'directory_mode', subject);
    requireCheck(node.uid === BigInt(process.getuid()), 'directory_owner', subject);
    checking('directory_canonical', subject);
    requireCheck((await fs.realpath(path)) === path, 'directory_canonical', subject);
    requireCheck(
      typeof node.ino === 'bigint' && validWorkspaceInode(String(node.ino)),
      'directory_inode',
      subject,
    );
    return node;
  };
  const readBytes = async (path, limit, privateFile = true) => {
    const subject = privateFile ? subjectOf(path) : 'changed_file';
    checking('file_open', subject);
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      checking('file_metadata', subject);
      const before = await handle.stat({ bigint: true });
      requireCheck(before.isFile(), 'file_type', subject);
      requireCheck(before.size <= BigInt(limit), 'file_size', subject);
      requireCheck(before.uid === BigInt(process.getuid()), 'file_owner', subject);
      if (privateFile) {
        requireCheck((before.mode & 0o077n) === 0n, 'file_mode', subject);
        requireCheck(before.nlink === 1n, 'file_links', subject);
      }
      checking('file_read', subject);
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      requireCheck(
        bytes.length <= limit &&
          before.ino === after.ino &&
          before.size === after.size &&
          before.mtimeNs === after.mtimeNs,
        'file_unchanged',
        subject,
      );
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const sync = async (path) => {
    const handle = await fs.open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  const absent = async (path, code) => {
    try {
      await fs.lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    fail(code);
  };
  const isClaude = (argv) =>
    /(?:^|\/)claude$/.test(argv[0] ?? '') ||
    argv[1] === '/usr/local/bin/claude' ||
    (argv[1] ?? '').endsWith('/node_modules/@anthropic-ai/claude-code/cli.js');
  const processInfo = async (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 2) fail('barrier_not_active');
    const [stat, command] = await Promise.all([
      fs.readFile(`${procRoot}/${pid}/stat`, 'utf8'),
      fs.readFile(`${procRoot}/${pid}/cmdline`),
    ]);
    if (stat.length > 4096 || !stat.startsWith(`${pid} (`) || command.length > 128 * 1024)
      fail('barrier_invalid');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/ +/);
    if (!/^\d+$/.test(fields[19] ?? '') || ['Z', 'X'].includes(fields[0]))
      fail('barrier_not_active');
    const after = await fs.readFile(`${procRoot}/${pid}/stat`, 'utf8');
    const afterFields = after
      .slice(after.lastIndexOf(')') + 2)
      .trim()
      .split(/ +/);
    if (afterFields[19] !== fields[19] || afterFields[1] !== fields[1]) fail('barrier_not_active');
    return {
      pid,
      ppid: Number(fields[1]),
      startTicks: fields[19],
      argv: command.toString('utf8').split('\0').filter(Boolean),
    };
  };
  const readMarker = async () => {
    try {
      const markerDirectory = `${project}/.ne02-qualification`;
      await privateDirectory(markerDirectory);
      const bytes = await readBytes(`${markerDirectory}/${input.nonce}.json`, 4096);
      const marker = JSON.parse(bytes);
      const markerSha256 = sha(bytes);
      if (
        marker.schemaVersion !== 1 ||
        marker.nonce !== input.nonce ||
        !Number.isSafeInteger(marker.pid) ||
        marker.pid < 2 ||
        !Number.isSafeInteger(marker.ppid) ||
        marker.ppid < 2 ||
        !/^\d{1,24}$/.test(marker.startTicks ?? '') ||
        !Number.isSafeInteger(marker.startedAt) ||
        marker.startedAt < 1 ||
        marker.deadline !== marker.startedAt + 150_000 ||
        marker.startedAt > now() ||
        (input.markerSha256 !== undefined && markerSha256 !== input.markerSha256)
      )
        fail('barrier_invalid');
      return { marker, markerSha256 };
    } catch {
      fail('barrier_invalid');
    }
  };
  const activeBarrier = async (marker) => {
    try {
      if (marker.deadline - now() < 45_000) fail('barrier_not_active');
      const info = await processInfo(marker.pid);
      kill(info.pid, 0);
      if (
        info.ppid !== marker.ppid ||
        info.startTicks !== marker.startTicks ||
        info.argv.length !== 4 ||
        !/(?:^|\/)node$/.test(info.argv[0]) ||
        info.argv[1] !== '--input-type=module' ||
        info.argv[2] !== '-e' ||
        info.argv[3] !== barrierSource(input.nonce) ||
        (await fs.realpath(`${procRoot}/${info.pid}/cwd`)) !== project
      )
        fail('barrier_invalid');
      let parent = info.ppid;
      let claudePid;
      for (let hops = 0; hops < 16 && parent > 1; hops++) {
        const ancestor = await processInfo(parent);
        if (isClaude(ancestor.argv)) {
          claudePid = ancestor.pid;
          break;
        }
        if (ancestor.ppid === parent) break;
        parent = ancestor.ppid;
      }
      if (!claudePid) fail('barrier_invalid');
      return {
        pid: info.pid,
        ppid: info.ppid,
        startTicks: info.startTicks,
        claudePid,
        deadline: marker.deadline,
        observedAt: now(),
      };
    } catch (error) {
      if (['barrier_invalid', 'barrier_not_active'].includes(error.code)) throw error;
      fail('barrier_not_active');
    }
  };
  try {
    if (
      !['inspect', 'inspect-workspace', 'missing-project', 'wrong-project'].includes(
        input.action,
      ) ||
      !Number.isSafeInteger(input.writerGeneration) ||
      input.writerGeneration < 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        input.nonce ?? '',
      ) ||
      input.identity?.epoch !== 1 ||
      keys.some(
        (key) => key !== 'epoch' && !/^[A-Za-z0-9_-]{1,128}$/.test(input.identity?.[key]),
      ) ||
      !/^[a-f0-9]{64}$/.test(input.configurationSha256 ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(input.packageId ?? '') ||
      typeof input.requireBarrier !== 'boolean' ||
      (input.markerSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.markerSha256)) ||
      (input.action === 'inspect' &&
        !input.requireBarrier &&
        !/^[a-f0-9]{64}$/.test(input.markerSha256 ?? ''))
    )
      fail('invalid_arguments');
    const nodes = {};
    for (const [name, path] of [
      ['root', root],
      ['project', project],
      ['machine', `${root}/machine`],
      ['control', control],
      ['owner', ownerDirectory],
    ]) {
      if (name === 'project' && input.action === 'inspect-workspace') continue;
      nodes[name] = await privateDirectory(path);
    }
    checking('nfs_mount');
    if (inspectMount) await inspectMount();
    else
      requireNfsMount(
        await fs.readFile('/proc/self/mountinfo', 'utf8'),
        await fs.statfs(root),
        nodes.root.dev,
        root,
      );
    const workspaceBytes = await readBytes(`${control}/workspace.json`, 2 * 1024 * 1024);
    const ownerBytes = await readBytes(`${ownerDirectory}/owner.json`, 8192);
    checking('workspace_parse');
    const workspace = JSON.parse(workspaceBytes);
    checking('owner_parse');
    const owner = JSON.parse(ownerBytes);
    requireCheck(workspace?.schemaVersion === 1, 'workspace_schema');
    requireCheck(owner?.schemaVersion === 1, 'owner_schema');
    for (const name of ['root', 'project', 'machine'])
      if (validWorkspaceInode(workspace.nodes?.[name]?.ino))
        inodes[`recorded_${name}`] = workspace.nodes[name].ino;
    requireCheck(sameIdentity(workspace.identity), 'workspace_identity');
    requireCheck(sameIdentity(owner.identity), 'owner_identity');
    requireCheck((owner.writerGeneration ?? 1) === input.writerGeneration, 'owner_writer');
    requireCheck(owner.configurationSha256 === input.configurationSha256, 'owner_configuration');
    requireCheck(
      workspace.configurationSha256 === input.configurationSha256,
      'workspace_configuration',
    );
    requireCheck(workspace.packageId === input.packageId, 'workspace_package');
    requireCheck(validWorkspaceInode(workspace.nodes?.project?.ino), 'workspace_project_inode');
    for (const key of ['root', 'project', 'machine']) {
      if (key === 'project' && input.action === 'inspect-workspace') continue;
      requireCheck(
        String(nodes[key].ino) === workspace.nodes?.[key]?.ino,
        'workspace_node_identity',
        key,
      );
    }
    checking('next_writer_absent');
    await absent(`${control}/writer-${input.writerGeneration + 1}`, 'next_writer_exists');
    const unchanged = async () => {
      for (const [name, path] of [
        ['root', root],
        ['machine', `${root}/machine`],
        ['control', control],
        ['owner', ownerDirectory],
      ]) {
        const after = await privateDirectory(path);
        requireCheck(after.ino === nodes[name].ino, 'directory_unchanged', name);
      }
      const nextWorkspace = await readBytes(`${control}/workspace.json`, 2 * 1024 * 1024);
      requireCheck(nextWorkspace.equals(workspaceBytes), 'workspace_unchanged');
      const nextOwner = await readBytes(`${ownerDirectory}/owner.json`, 8192);
      requireCheck(nextOwner.equals(ownerBytes), 'owner_unchanged');
      checking('next_writer_absent');
      await absent(`${control}/writer-${input.writerGeneration + 1}`, 'next_writer_exists');
    };
    const result = {
      schemaVersion: 1,
      ok: true,
      action: input.action,
      nonce: input.nonce,
      rootInode: String(nodes.root.ino),
      projectInode: workspace.nodes.project.ino,
      machineInode: String(nodes.machine.ino),
      workspaceSha256: sha(workspaceBytes),
      configurationSha256: input.configurationSha256,
    };
    if (input.action === 'inspect') {
      checking('barrier');
      const firstMarker = await readMarker();
      if (input.requireBarrier) await activeBarrier(firstMarker.marker);
      const names = new Set();
      for (const args of [
        ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--'],
        ['ls-files', '--others', '--exclude-standard', '-z'],
      ]) {
        const value = await git(
          'git',
          ['--no-pager', '-c', 'core.fsmonitor=false', '-C', project, ...args],
          {
            encoding: 'utf8',
            timeout: 10_000,
            maxBuffer: 64 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          },
        );
        for (const path of value.stdout.split('\0')) {
          if (
            /^[A-Za-z0-9_/-][A-Za-z0-9_. /-]{0,511}\.(?:[cm]?js|jsx|tsx?|css|html|json|vue|svelte|py|go|rs|java)$/.test(
              path,
            ) &&
            !path.split('/').some((part) => part.startsWith('.')) &&
            !/^(?:node_modules|aidlc-docs|aidlc-workflows)\//.test(path)
          )
            names.add(path);
        }
      }
      checking('changed_files');
      if ((input.requireBarrier && !names.size) || names.size > 32)
        fail('unfinished_files_missing');
      result.changedFiles = [];
      for (const path of [...names].toSorted()) {
        const full = `${project}/${path}`;
        checking('file_canonical', 'changed_file');
        if ((await fs.realpath(full)) !== full) fail('workspace_invalid');
        const bytes = await readBytes(full, 8 * 1024 * 1024, false);
        result.changedFiles.push({
          pathSha256: sha(path),
          sha256: sha(bytes),
          bytes: bytes.length,
        });
      }
      const bin = `${project}/node_modules/.bin`;
      checking('dependency_links');
      if ((await fs.realpath(bin)) !== bin) fail('workspace_invalid');
      const entries = await fs.readdir(bin);
      if (entries.length > 512) fail('dependency_links_missing');
      const links = [];
      let hardlinkedTargets = 0;
      for (const name of entries.toSorted()) {
        const path = `${bin}/${name}`;
        if (!(await fs.lstat(path)).isSymbolicLink()) continue;
        const target = await fs.realpath(path);
        if (!target.startsWith(`${project}/node_modules/`)) continue;
        const node = await fs.lstat(target, { bigint: true });
        if (!node.isFile()) continue;
        if (node.nlink > 1n) hardlinkedTargets++;
        links.push([sha(name), sha(await fs.readlink(path)), String(node.ino), String(node.nlink)]);
      }
      if (!links.length) fail('dependency_links_missing');
      result.dependencies = {
        symlinkCount: links.length,
        hardlinkedTargets,
        sha256: sha(JSON.stringify(links)),
      };
      const lastMarker = await readMarker();
      if (lastMarker.markerSha256 !== firstMarker.markerSha256) fail('barrier_invalid');
      result.markerSha256 = lastMarker.markerSha256;
      result.markerEvidence = input.requireBarrier ? 'live' : 'retained';
      if (input.requireBarrier) result.barrier = await activeBarrier(lastMarker.marker);
      await unchanged();
      requireCheck(
        (await privateDirectory(project)).ino === nodes.project.ino,
        'directory_unchanged',
        'project',
      );
      return result;
    }
    checking('harness_inactive');
    const pids = (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name));
    if (pids.length > 4096) fail('active_harness');
    for (const pid of pids) {
      const info = await processInfo(Number(pid)).catch((error) => {
        if (
          error.code === 'ENOENT' ||
          error.code === 'ESRCH' ||
          error.code === 'barrier_not_active'
        )
          return null;
        throw error;
      });
      if (info && isClaude(info.argv)) fail('active_harness');
    }
    if (input.action === 'inspect-workspace') {
      const optionalDirectory = async (path) => {
        try {
          return await privateDirectory(path);
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      };
      const paths = [project, quarantine, `${quarantine}/project`];
      const observed = [];
      for (const path of paths) observed.push(await optionalDirectory(path));
      const [currentProject, quarantineDirectory, original] = observed;
      requireCheck(
        !original || (quarantineDirectory && String(original.ino) === workspace.nodes.project.ino),
        'layout_original_inode',
      );
      requireCheck(
        !currentProject ||
          (original
            ? String(currentProject.ino) !== workspace.nodes.project.ino
            : String(currentProject.ino) === workspace.nodes.project.ino),
        'layout_current_inode',
      );
      checking('layout_children');
      if (quarantineDirectory && (await fs.readdir(quarantine)).some((name) => name !== 'project'))
        fail('workspace_invalid');
      await unchanged();
      for (let index = 0; index < paths.length; index++) {
        const after = await optionalDirectory(paths[index]);
        requireCheck(
          after?.ino === observed[index]?.ino,
          'layout_unchanged',
          subjectOf(paths[index]),
        );
      }
      return {
        ...result,
        ownerSha256: sha(ownerBytes),
        observedProjectInode: currentProject ? String(currentProject.ino) : null,
        quarantineInode: quarantineDirectory ? String(quarantineDirectory.ino) : null,
        quarantinedProjectInode: original ? String(original.ino) : null,
      };
    }
    checking('quarantine_absent');
    await absent(quarantine, 'quarantine_exists');
    await unchanged();
    requireCheck(
      (await privateDirectory(project)).ino === nodes.project.ino,
      'directory_unchanged',
      'project',
    );
    checking('quarantine_create');
    await fs.mkdir(quarantine, { mode: 0o700 });
    await privateDirectory(quarantine);
    await unchanged();
    checking('quarantine_rename');
    await fs.rename(project, `${quarantine}/project`);
    quarantined = true;
    checking('quarantine_sync');
    await sync(quarantine);
    await sync(root);
    requireCheck(
      (await privateDirectory(`${quarantine}/project`)).ino === nodes.project.ino,
      'quarantine_original_inode',
    );
    if (input.action === 'wrong-project') {
      checking('replacement_create');
      await fs.mkdir(project, { mode: 0o700 });
      const replacement = await privateDirectory(project);
      requireCheck(replacement.ino !== nodes.project.ino, 'replacement_inode');
      result.replacementInode = String(replacement.ino);
      await sync(root);
    } else {
      checking('project_absent');
      await absent(project, 'workspace_invalid');
    }
    await unchanged();
    return { ...result, quarantined: true };
  } catch (error) {
    return {
      schemaVersion: 1,
      ok: false,
      action: input.action,
      nonce: input.nonce,
      code: qualificationCode(error),
      validation: {
        ...validation,
        inodes,
        ...(WORKSPACE_FILESYSTEM_CODES.includes(error?.code) ? { filesystemCode: error.code } : {}),
      },
      ...(['missing-project', 'wrong-project'].includes(input.action) ? { quarantined } : {}),
    };
  }
}

export function workspaceCommand(input) {
  const source = [
    "import * as filesystem from 'node:fs/promises';",
    "import {constants} from 'node:fs';",
    "import {createHash} from 'node:crypto';",
    "import {execFile} from 'node:child_process';",
    "import {promisify} from 'node:util';",
    "const NATIVE_MOUNT='/mnt/native';",
    `const QUALIFICATION_CODES=${JSON.stringify(QUALIFICATION_CODES)};`,
    `const WORKSPACE_INODE_FIELDS=${JSON.stringify(WORKSPACE_INODE_FIELDS)};`,
    `const WORKSPACE_FILESYSTEM_CODES=${JSON.stringify(WORKSPACE_FILESYSTEM_CODES)};`,
    `const qualificationError=${qualificationError.toString()};`,
    `const qualificationCode=${qualificationCode.toString()};`,
    validWorkspaceInode.toString(),
    probeError.toString(),
    requireNfsMount.toString(),
    qualificationBarrier.toString(),
    barrierSource.toString(),
    runWorkspaceOperation.toString(),
    `const result=await runWorkspaceOperation(${JSON.stringify(input)});`,
    "process.stdout.write(JSON.stringify(result)+'\\n');process.exitCode=result.ok?0:1;",
  ].join('\n');
  const command = `node --input-type=module -e '${source.replaceAll("'", "'\\''")}'`;
  // Bound the complete fixed command before transmitting it.
  if (Buffer.byteLength(command) > 65_536) throw qualificationError('invalid_arguments');
  return command;
}
