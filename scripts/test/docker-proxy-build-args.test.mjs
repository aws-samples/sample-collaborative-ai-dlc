import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker-proxy-build-args.mjs');

const collectBuildArgs = (env) =>
  JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', env }));

test('returns an empty map when no proxy variables are set', () => {
  assert.deepEqual(collectBuildArgs({}), {});
});

test('forwards non-empty uppercase and lowercase proxy variables', () => {
  assert.deepEqual(
    collectBuildArgs({
      HTTP_PROXY: 'http://proxy.example.com:8080',
      HTTPS_PROXY: '',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://lower-proxy.example.com:8080',
      npm_config_proxy: 'http://ignored.example.com:8080',
    }),
    {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      NO_PROXY: 'localhost,127.0.0.1',
      http_proxy: 'http://lower-proxy.example.com:8080',
    },
  );
});

test('emits JSON-safe proxy values without modification', () => {
  const proxy = 'http://proxy.example.com/a"b\\c';
  assert.deepEqual(collectBuildArgs({ ALL_PROXY: proxy }), { ALL_PROXY: proxy });
});
