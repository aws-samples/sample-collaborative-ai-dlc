import { fileURLToPath } from 'node:url';

// The offline release/compatibility suites: everything that can be replayed from
// the pinned fixtures with no network, no AWS credentials, and no live GitHub —
// the compatibility evidence contract. `aidlc-release` is included despite importing
// the S3 client types because it never issues a call (the client is injected);
// `release-resolver` and `release-registry` drive mocked AWS clients and stay in
// the full `--project=shared` run.
export default {
  test: {
    root: fileURLToPath(new URL('./lambda/shared', import.meta.url)),
    include: [
      'test/aidlc-compatibility.test.js',
      'test/aidlc-custom-source.test.js',
      'test/aidlc-ref.test.js',
      'test/aidlc-release-adapters.test.js',
      'test/aidlc-release-importer.test.js',
      'test/aidlc-release.test.js',
      'test/release-matrix.test.js',
      'test/block-mappers.test.js',
      'test/frontmatter.test.js',
      'test/v2-execution-plan.test.js',
    ],
    environment: 'node',
  },
};
