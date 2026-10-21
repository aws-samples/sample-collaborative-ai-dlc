import { describe, expect, it, vi } from 'vitest';
import { nativeDependencyLinks, NATIVE_DEPENDENCY_POLICY } from '../native-dependency-links.js';
import { nativeRecoveryBinLinks } from '../native-recovery-bin-links.js';
const link = (path, target) => ({ scope: 'project', path, target, mode: 0o777, mtimeNs: '1' });
const fixture = () => ({
  metadata: {
    schemaVersion: 3,
    filesystemPolicy: NATIVE_DEPENDENCY_POLICY,
    harness: 'claude',
    binLinks: [],
    hardlinks: [],
    directories: ['', 'node_modules', 'node_modules/.bin', 'vendor', 'vendor/pkg'].map((path) => ({
      scope: 'project',
      path,
      mode: 0o755,
      mtimeNs: '1',
    })),
    dependencyLinks: [
      link('node_modules/pkg', '../vendor/pkg'),
      link('node_modules/.bin/tool', '../pkg/tool.js'),
    ],
  },
  files: [{ scope: 'project', path: 'vendor/pkg/tool.js', bytes: 10 }],
});
const plan = ({ metadata, files }, limits) => nativeRecoveryBinLinks(metadata, files, limits);
describe('closed dependency inventory', () => {
  it('resolves npm directory aliases and executable chains without filesystem reads', () => {
    expect(plan(fixture()).map(({ target }) => target)).toEqual([
      'vendor/pkg',
      'vendor/pkg/tool.js',
    ]);
  });
  it.each([
    ['self-cycle', './pkg'],
    ['directory-cycle', '.'],
    ['absolute', '/vendor/pkg'],
    ['escape-return', '../../project/vendor/pkg'],
    ['missing', '../missing'],
    ['private', '../.native-control'],
    ['credential', '../vendor/pkg/.npmrc'],
    ['missing-before-parent', '../missing/../vendor/pkg'],
    ['file-before-parent', '../vendor/pkg/tool.js/../tool.js'],
  ])('rejects %s in both direct and checkpoint planning', (_name, target) => {
    const f = fixture();
    f.metadata.dependencyLinks[0].target = target;
    expect(() => plan(f)).toThrow();
  });
  it('rejects cycles between directory subtrees', () => {
    const f = fixture();
    f.metadata.directories.push(
      ...['vendor/pkg/node_modules', 'other', 'other/node_modules'].map((path) => ({
        scope: 'project',
        path,
        mode: 0o755,
        mtimeNs: '1',
      })),
    );
    f.metadata.dependencyLinks.push(
      link('vendor/pkg/node_modules/other', '../../../other'),
      link('other/node_modules/pkg', '../../vendor/pkg'),
    );
    expect(() => plan(f)).toThrow();
  });
  it.each(['alias-parent', 'file-parent', 'missing-parent', 'hardlinked-target'])(
    'refuses a malformed real inventory: %s',
    (kind) => {
      const f = fixture();
      if (kind === 'alias-parent')
        f.files.push({ scope: 'project', path: 'node_modules/pkg/child', bytes: 1 });
      if (kind === 'file-parent')
        f.files.push({ scope: 'project', path: 'vendor/pkg/tool.js/child', bytes: 1 });
      if (kind === 'missing-parent')
        f.metadata.directories = f.metadata.directories.filter((d) => d.path !== 'vendor');
      if (kind === 'hardlinked-target')
        f.metadata.hardlinks.push({ scope: 'project', paths: ['vendor/pkg/tool.js', 'other.js'] });
      expect(() => plan(f)).toThrow();
    },
  );
  it.each([{ entries: 6 }, { depth: 2 }, { pathBytes: 8 }, { totalBytes: 11 }])(
    'enforces a resource bound %j',
    (limits) => expect(() => plan(fixture(), limits)).toThrow(),
  );
  it('rejects excessive aliases and getters without evaluating them', () => {
    const f = fixture(),
      getter = vi.fn(() => {
        throw Error('private');
      });
    Object.defineProperty(f.metadata.dependencyLinks, '0', { get: getter, enumerable: true });
    expect(() => plan(f)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const many = fixture();
    many.metadata.dependencyLinks = Array.from({ length: 1025 }, (_, n) =>
      link(`node_modules/p${n}`, '../vendor/pkg'),
    );
    expect(() => plan(many)).toThrow();
  });
  it('never treats legacy metadata as permission for new dependency links', () => {
    const f = fixture();
    expect(() =>
      nativeDependencyLinks({ ...f.metadata, filesystemPolicy: 'unknown' }, f.files),
    ).toThrow();
    expect(() => plan({ ...f, metadata: { ...f.metadata, schemaVersion: 2 } })).toThrow();
    expect(() => plan({ ...f, metadata: { ...f.metadata, schemaVersion: 1 } })).toThrow();
  });
  it('bounds valid alias chains and rejects getter-bearing legacy arrays in v3', () => {
    const f = fixture();
    f.metadata.dependencyLinks = Array.from({ length: 16 }, (_, n) =>
      link(`node_modules/p${n}`, n === 15 ? '../vendor/pkg' : `./p${n + 1}`),
    );
    expect(plan(f)).toHaveLength(16);
    f.metadata.dependencyLinks.unshift(link('node_modules/extra', './p0'));
    expect(() => plan(f)).toThrow();
    const legacy = fixture();
    const getter = vi.fn();
    Object.defineProperty(legacy.metadata.binLinks, '0', { get: getter, enumerable: true });
    expect(() => plan(legacy)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
