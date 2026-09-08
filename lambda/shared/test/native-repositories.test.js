import { describe, expect, it } from 'vitest';
import { assignNativeRepositoryDirectories, repositoryId } from '../native-repositories.js';

describe('native repository projection', () => {
  it('preserves unique basenames as local directories', () => {
    expect(
      assignNativeRepositoryDirectories([
        { id: 'org/api', url: 'git@github.com:org/api.git' },
        { id: 'org/web', url: 'git@github.com:org/web.git' },
      ]),
    ).toEqual([
      { id: 'org/api', directory: 'api', url: 'git@github.com:org/api.git' },
      { id: 'org/web', directory: 'web', url: 'git@github.com:org/web.git' },
    ]);
  });

  it('assigns different stable directories to repositories with the same basename', () => {
    const repositories = assignNativeRepositoryDirectories([
      { id: 'org-a/api' },
      { id: 'org-b/api' },
    ]);

    expect(repositories.map((repository) => repository.id)).toEqual(['org-a/api', 'org-b/api']);
    expect(repositories.map((repository) => repository.directory)).toEqual([
      'org-a_api',
      'org-b_api',
    ]);
  });

  it('derives canonical identities from supported clone URL forms', () => {
    expect(repositoryId('owner/repo')).toBe('owner/repo');
    expect(repositoryId('git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(repositoryId('https://github.com/owner/repo.git')).toBe('owner/repo');
  });
});
