// Cedar's Node entry loads its WASM with fs. Keep the published package beside
// the bundle rather than asking esbuild to inline a filesystem-dependent module.
// The space policy is read relative to the bundle, so ship it beside it too.
import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = resolve(dirname(require.resolve('@cedar-policy/cedar-wasm/nodejs')), '..');
const destination = resolve('.build/node_modules/@cedar-policy/cedar-wasm');
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });

const policy = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../lambda/shared/policies/space.cedar',
);
await mkdir(resolve('.build/policies'), { recursive: true });
await cp(policy, resolve('.build/policies/space.cedar'));
