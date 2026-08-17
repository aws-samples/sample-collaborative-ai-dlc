import { createHash } from 'node:crypto';

// Reduce supported repository references and clone URLs to their canonical
// provider identity, such as `owner/repo`.
const repositoryId = (repository) => {
  const value = String(repository ?? '').trim();
  if (!value) return '';

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

const repositoryBasename = (id) => id.split('/').at(-1) || 'repository';
const directoryHash = (id) => createHash('sha256').update(id).digest('hex');

// Preserve canonical repository identity while assigning stable local checkout
// directories. Basenames stay readable unless more than one repository shares one.
const assignNativeRepositoryDirectories = (repositories) => {
  const normalized = repositories.map((repository) => {
    const id = repositoryId(repository.id);
    if (!id) throw new Error('native-export: repository identity is required');
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
    const directory = duplicateBasename ? repository.id.replaceAll('/', '_') : basename;
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

export { assignNativeRepositoryDirectories, repositoryId };
