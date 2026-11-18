// Display metadata verified against upstream GitHub releases/commits on 2026-11-05.
// Kept outside importer profiles: dates and links do not affect immutable closures.
const SOURCE_INFO = Object.freeze({
  'current-stable': {
    date: '2026-07-10T03:22:01Z',
    dateKind: 'commit',
    url: 'https://github.com/awslabs/aidlc-workflows/commit/83ed7a812c4024904f2c5e4d744e28077e0a5acd',
  },
  'v2.6.18': {
    date: '2026-08-19T13:32:07Z',
    dateKind: 'commit',
    url: 'https://github.com/awslabs/aidlc-workflows/commit/fbb1460c5225657dac7f5a025657785751b41634',
  },
  'v2.7.0': {
    date: '2026-09-01T03:04:51Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.7.0',
  },
  'v2.8.2': {
    date: '2026-09-11T09:25:56Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.8.2',
  },
  'v2.9.0': {
    date: '2026-09-15T09:22:52Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.9.0',
  },
  'v2.11.0': {
    date: '2026-10-08T11:24:38Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.0',
  },
  'v2.11.1': {
    date: '2026-10-20T01:34:46Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.1',
  },
  'v2.11.3': {
    date: '2026-11-04T06:09:40Z',
    dateKind: 'release',
    url: 'https://github.com/awslabs/aidlc-workflows/releases/tag/v2.11.3',
  },
});
export const releaseSourceInfo = (profileId) => SOURCE_INFO[profileId] ?? null;
