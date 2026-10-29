import assert from 'node:assert/strict';
import test from 'node:test';
import { guardRead, lexicalAmbiguity } from '../pr-impact/reader-guard.mjs';

test('pinned reader hazards in real pricing/pagination changes require file-wide evidence', () => {
  assert.equal(
    lexicalAmbiguity(['// esbuild WITHOUT `--external:@aws-sdk/*`']),
    'line-comment-block-token',
  );
  assert.equal(
    lexicalAmbiguity(['const tokenPattern = /(```|`[^`]+`)/g;']),
    'regex-backtick-token',
  );
  assert.equal(lexicalAmbiguity(['const message = "Use `code`";']), 'quoted-backtick-token');
  assert.equal(lexicalAmbiguity(['const message = `Hello ${name}`;']), null);
});

test('escaped regex bodies are scanned without ambiguous backtracking', () => {
  const repeated = '\\.'.repeat(20_000);
  assert.equal(lexicalAmbiguity([`const pattern = /${repeated}`]), null);
  assert.equal(lexicalAmbiguity([`const pattern = /${repeated}\`/g;`]), 'regex-backtick-token');
  assert.equal(lexicalAmbiguity([`const text = "${'\\\\'.repeat(20_000)}";`]), null);
});

test('ambiguous declarations lose named attribution and retain an explicit fallback', () => {
  const read = {
    shapes: new Map([['pricing.js', { kind: 'comments', touches: [{ name: 'wrong' }] }]]),
    users: [{ of: 'pricing.js', path: 'user.js', uses: 1 }],
    added: new Map([['pricing.js', ['const price = 11;']]]),
  };
  guardRead(read, new Map(), new Map());
  assert.equal(read.shapes.get('pricing.js').kind, 'file');
  assert.deepEqual(read.shapes.get('pricing.js').touches, []);
  assert.deepEqual(read.users, []);
  assert.equal(read.fallbacks.get('pricing.js'), 'lexical-ambiguity:quiet-code-contradiction');
});

test('actual quiet comment changes retain their precise classification', () => {
  const read = {
    shapes: new Map([['source.js', { kind: 'comments' }]]),
    users: [],
    added: new Map([['source.js', ['// Explain the return value.', '']]]),
  };
  guardRead(read, new Map(), new Map());
  assert.equal(read.shapes.get('source.js').kind, 'comments');
  assert.equal(read.fallbacks.size, 0);
});

test('pure removal of behavior after a quoted block token cannot remain comments-only', () => {
  const read = {
    shapes: new Map([['source.js', { kind: 'comments', touches: [] }]]),
    users: [],
    added: new Map([['source.js', []]]),
  };
  guardRead(
    read,
    new Map([['source.js', ['const delimiter = "/*";', 'export const send = () => 1;']]]),
    new Map([['source.js', ['const delimiter = "/*";']]]),
  );
  assert.equal(read.shapes.get('source.js').kind, 'file');
  assert.equal(read.fallbacks.get('source.js'), 'lexical-ambiguity:quoted-block-comment-token');
});
