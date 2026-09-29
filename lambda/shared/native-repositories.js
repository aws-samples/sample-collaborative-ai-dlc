import { createHash } from 'node:crypto';
import {
  CODECOMMIT_REPO_ARN_PATTERN,
  isValidRepoPath,
  repoCheckoutPath,
} from './repo-validation.js';
import { parseCodeCommitRepo } from './git-providers/codecommit-repo.js';
import { codeCommitCloneUrl } from './git-providers/codecommit-credential.js';

// Reduce supported repository references and clone URLs to their canonical
// provider identity, such as `owner/repo`. A CodeCommit ARN is already
// canonical and is kept verbatim (region and account are part of it).
const repositoryId = (repository) => {
  const value = String(repository ?? '').trim();
  if (!value) return '';
  if (CODECOMMIT_REPO_ARN_PATTERN.test(value)) return value;

  let path = value;
  if (value.startsWith('git@')) {
    path = value.slice(value.indexOf(':') + 1);
  } else if (/^(?:https?|ssh):\/\//.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      path = value;
    }
  }
  return path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
};

// Readable directory candidates. A CodeCommit ARN reads as its repository name
// and, when that name is shared, as its flattened checkout path
// (codecommit_<partition>_<region>_<account>_<name>): never a colon-laden ARN.
const repositoryBasename = (id) => repoCheckoutPath(id).split('/').at(-1) || 'repository';
const flattenedId = (id) => repoCheckoutPath(id).replaceAll('/', '_');
const directoryHash = (id) => createHash('sha256').update(id).digest('hex');

// Preserve canonical repository identity while assigning stable local checkout
// directories. Basenames stay readable unless more than one repository shares one.
const assignNativeRepositoryDirectories = (repositories) => {
  const normalized = repositories.map((repository) => {
    const id = repositoryId(repository.id);
    if (!id) throw new Error('native-export: repository identity is required');
    if (!isValidRepoPath(id)) throw new Error('native-export: invalid repository path');
    return { ...repository, id, basename: repositoryBasename(id) };
  });

  const ids = new Set();
  for (const repository of normalized) {
    const key = repository.id.toLowerCase();
    if (ids.has(key)) {
      throw new Error(`native-export: duplicate repository identity ${repository.id}`);
    }
    ids.add(key);
  }

  const basenameCounts = new Map();
  for (const repository of normalized) {
    const key = repository.basename.toLowerCase();
    basenameCounts.set(key, (basenameCounts.get(key) ?? 0) + 1);
  }

  const candidates = normalized.map(({ basename, ...repository }) => {
    const digest = directoryHash(repository.id);
    const duplicateBasename = basenameCounts.get(basename.toLowerCase()) > 1;
    const directory = duplicateBasename ? flattenedId(repository.id) : basename;
    return { ...repository, directory, digest };
  });

  const candidateCounts = new Map();
  for (const repository of candidates) {
    const key = repository.directory.toLowerCase();
    candidateCounts.set(key, (candidateCounts.get(key) ?? 0) + 1);
  }

  const projected = candidates.map(({ digest, ...repository }) => ({
    ...repository,
    directory:
      candidateCounts.get(repository.directory.toLowerCase()) > 1
        ? `${repository.directory}-${digest.slice(0, 8)}`
        : repository.directory,
  }));
  if (
    new Set(projected.map((repository) => repository.directory.toLowerCase())).size !==
    projected.length
  ) {
    throw new Error('native-export: could not derive unique repository directories');
  }
  return projected;
};

// Clone URL written into the native workspace manifest.
const repositoryCloneUrl = (repository, provider) => {
  const value = String(repository ?? '');
  if (/^(?:https?|ssh):\/\//.test(value) || value.startsWith('git@')) return value;
  if (provider === 'gitlab') return `git@gitlab.com:${value}.git`;
  if (provider === 'bitbucket') return `git@bitbucket.org:${value}.git`;
  if (provider === 'codecommit') {
    // The regional HTTPS endpoint, the form every CodeCommit credential works
    // with (git-remote-codecommit, credential helper, Git credentials).
    const { region, repositoryName } = parseCodeCommitRepo(value);
    return codeCommitCloneUrl(region, repositoryName);
  }
  return `git@github.com:${value}.git`;
};

export { assignNativeRepositoryDirectories, repositoryCloneUrl, repositoryId };
