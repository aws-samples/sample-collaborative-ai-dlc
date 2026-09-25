import { describe, expect, it } from 'vitest';
import {
  assignNativeRepositoryDirectories,
  repositoryCloneUrl,
  repositoryId,
} from '../native-repositories.js';

const CC_WEST1 = 'arn:aws:codecommit:eu-west-1:123456789012:app';
const CC_WEST2 = 'arn:aws:codecommit:eu-west-2:123456789012:app';

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

  it.each(['owner/.', 'owner/..', 'owner/../repo', './repo', '../repo'])(
    'rejects unsafe repository paths before assigning directories: %s',
    (id) => {
      expect(() => assignNativeRepositoryDirectories([{ id }])).toThrow(
        'native-export: invalid repository path',
      );
    },
  );

  it.each(['-repo', '.github', 'test...plop'])(
    'preserves safe repository basenames: %s',
    (name) => {
      expect(assignNativeRepositoryDirectories([{ id: `owner/${name}` }])).toEqual([
        { id: `owner/${name}`, directory: name },
      ]);
    },
  );

  it('keeps a CodeCommit ARN as identity and exports it under its repository name', () => {
    expect(repositoryId(CC_WEST1)).toBe(CC_WEST1);
    expect(
      assignNativeRepositoryDirectories([
        { id: CC_WEST1, url: repositoryCloneUrl(CC_WEST1, 'codecommit') },
      ]),
    ).toEqual([
      {
        id: CC_WEST1,
        directory: 'app',
        url: 'https://git-codecommit.eu-west-1.amazonaws.com/v1/repos/app',
      },
    ]);
  });

  it('exports same-name CodeCommit repositories from two regions to distinct directories', () => {
    const repositories = assignNativeRepositoryDirectories([
      { id: CC_WEST1 },
      { id: CC_WEST2 },
      { id: 'org/api' },
    ]);
    expect(repositories.map((repository) => repository.directory)).toEqual([
      'codecommit_aws_eu-west-1_123456789012_app',
      'codecommit_aws_eu-west-2_123456789012_app',
      'api',
    ]);
    for (const { directory } of repositories) expect(directory).not.toContain(':');
  });

  it('builds provider clone URLs, CodeCommit on its regional HTTPS endpoint', () => {
    expect(repositoryCloneUrl(CC_WEST2, 'codecommit')).toBe(
      'https://git-codecommit.eu-west-2.amazonaws.com/v1/repos/app',
    );
    expect(
      repositoryCloneUrl('arn:aws-cn:codecommit:cn-north-1:123456789012:svc', 'codecommit'),
    ).toBe('https://git-codecommit.cn-north-1.amazonaws.com.cn/v1/repos/svc');
    expect(repositoryCloneUrl('owner/repo', 'github')).toBe('git@github.com:owner/repo.git');
    expect(repositoryCloneUrl('group/repo', 'gitlab')).toBe('git@gitlab.com:group/repo.git');
  });
});
