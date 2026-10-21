// Test/controller adapters are separate from the immutable runtime under /opt.
// Absolute symlinks resolve only inside the container; no candidate production
// source is mounted over the image.
import * as fs from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const excluded = new Set(['node_modules', '.build', 'builds', 'package-lock.json', '.gitignore']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const controllers = [
  'execution-worker.js',
  'execution-api.js',
  'execution-runtime.js',
  'test/execution-fixtures.js',
  'test/memory-objects.js',
  'test/fixtures.js',
];

async function bundleControllerAdapter(root, directory) {
  // Lambda has its own dependency closure. Keep the real controller and its
  // in-memory AWS ports separate from production modules under /opt.
  const filename = join(directory, 'controller-qualification.mjs');
  await build({
    stdin: {
      contents: controllers
        .map((path) => `export * from './lambda/native-runtime-control/${path}';`)
        .join('\n'),
      resolveDir: root,
    },
    outfile: filename,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    },
    logLevel: 'silent',
  });
  const runner = join(directory, 'scripts/native-installed-qualification.mjs');
  let source = await fs.readFile(runner, 'utf8');
  for (const path of controllers)
    source = source.replaceAll(
      `'../lambda/native-runtime-control/${path}'`,
      "'../controller-qualification.mjs'",
    );
  await fs.writeFile(runner, source);
  return hash(await fs.readFile(filename));
}

export async function stagePackagedQualification(root) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'native-packaged-'));
  await fs.chmod(directory, 0o755);
  const manifest = [];
  const copy = async (path) => {
    await fs.mkdir(dirname(join(directory, path)), { recursive: true });
    await fs.cp(join(root, path), join(directory, path), {
      recursive: true,
      filter: (source) =>
        !relative(root, source)
          .split('/')
          .some((part) => excluded.has(part)),
    });
  };
  const linkProduction = async (workspace, path = '') => {
    const source = join(root, 'lambda', workspace, path);
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.name === 'test' || entry.name.endsWith('.test.js'))
        continue;
      const item = join(path, entry.name);
      if (entry.isDirectory()) await linkProduction(workspace, item);
      else {
        if (!entry.isFile()) throw new Error(`Unexpected production source entry: ${item}`);
        const target = `/opt/${workspace}/${item}`;
        const destination = join(directory, 'lambda', workspace, item);
        await fs.mkdir(dirname(destination), { recursive: true });
        await fs.symlink(target, destination);
        manifest.push({ path: target, sha256: hash(await fs.readFile(join(source, entry.name))) });
      }
    }
  };
  try {
    await fs.mkdir(join(directory, 'node_modules'));
    for (const path of [
      'scripts',
      'test',
      'package.json',
      'vitest.native-foundation.config.js',
      'lambda/native-runtime-control',
      'lambda/agentcore/test',
      'lambda/shared/test',
    ])
      await copy(path);
    for (const workspace of ['agentcore', 'shared']) await linkProduction(workspace);
    // Linux tests inspect the root lock to verify the prepared native binding.
    await fs.copyFile(join(root, 'package-lock.json'), join(directory, 'package-lock.json'));
    await fs.writeFile(join(directory, 'packaged-source.json'), JSON.stringify(manifest));
    const controllerSha256 = await bundleControllerAdapter(root, directory);
    return {
      directory,
      sourceSha256: hash(JSON.stringify(manifest)),
      controllerSha256,
      files: manifest.length,
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
