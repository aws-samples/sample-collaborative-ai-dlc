import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// These three exceptions in lambda/.dockerignore are copied into the image
// but were never part of the Terraform source tag.
export const harnessFiles = [
  'agentcore/test/local-e2e-config.js',
  'agentcore/test/local-e2e-harness.mjs',
  'agentcore/test/helpers/v2-table.js',
];

const excluded = new Set(['.build', '.git', 'node_modules', 'test']);
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

export function runtimeSourceInventory(sourcePath) {
  const root = realpathSync(sourcePath);
  const paths = [];
  function walk(directory) {
    if (!lstatSync(join(root, directory)).isDirectory()) {
      throw new Error(`Expected runtime source directory: ${directory}`);
    }
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isFile()) paths.push(path);
      else if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) walk(path);
      } else throw new Error(`Unexpected runtime source entry: ${path}`);
    }
  }
  for (const directory of ['agentcore', 'shared', 'native-runtime-control']) walk(directory);
  // Terraform sort uses Unicode code point order (equivalently UTF-8 byte order).
  paths.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  function fileInfo(path, optional = false) {
    const file = join(root, path);
    const stat = lstatSync(file, { throwIfNoEntry: !optional });
    if (!stat) return null;
    if (!stat.isFile() || realpathSync(file) !== file) {
      throw new Error(`Expected regular runtime source file: ${path}`);
    }
    const bytes = readFileSync(file);
    return {
      path: `lambda/${path}`,
      mode: stat.mode & 0o777,
      bytes: bytes.length,
      sha1: hash('sha1', bytes),
      sha256: hash('sha256', bytes),
    };
  }
  const files = paths.map((path) => fileInfo(path));
  const context = ['.dockerignore', ...harnessFiles].map((path) => fileInfo(path, true));
  return {
    files,
    source_sha1: hash('sha1', files.map((file) => file.sha1).join('')),
    inventory_sha256: hash('sha256', JSON.stringify([...files, ...context])),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { source_sha1, inventory_sha256 } = runtimeSourceInventory(
      JSON.parse(readFileSync(0, 'utf8')).source_path,
    );
    console.log(JSON.stringify({ source_sha1, inventory_sha256 }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
