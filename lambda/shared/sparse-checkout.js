// Directory-only cone selections. Empty/omitted selections keep a full checkout.
// Shared by the API and runtime so direct runtime calls cannot bypass validation.
export const validateSparseDirectories = (input) => {
  if (input == null) return { value: [] };
  if (!Array.isArray(input) || input.length > 100) {
    return { error: 'sparseCheckout requires an array of at most 100 directories per repository' };
  }
  const paths = [];
  for (const raw of input) {
    // A trailing slash is a common way to type a directory; it names the
    // same cone directory, so normalize it instead of rejecting the entry.
    const entry = typeof raw === 'string' ? raw.replace(/\/+$/, '') : raw;
    if (
      typeof entry !== 'string' ||
      !entry ||
      entry !== entry.trim() ||
      entry.length > 1024 ||
      /[\\*?[\]":]/.test(entry) ||
      [...entry].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      entry.startsWith('-') ||
      entry
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    ) {
      return {
        error: `sparseCheckout directory ${JSON.stringify(raw)} is invalid: use a repository-relative directory such as services/api, without a leading ./ or /, surrounding whitespace, . or .. components, .git, or glob characters`,
      };
    }
    paths.push(entry);
  }
  return { value: [...new Set(paths)] };
};

export const validateSparseCheckout = (input, repos) => {
  if (input == null) return { value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'sparseCheckout must be an object of { repoUrl: directories[] }' };
  }
  const allowed = new Set(
    (repos ?? []).map((repo) => (typeof repo === 'string' ? repo : repo.url)),
  );
  const entries = [];
  for (const [repo, directories] of Object.entries(input)) {
    if (!allowed.has(repo))
      return { error: `sparseCheckout references a repo not on this project: ${repo}` };
    if (!Array.isArray(directories))
      return { error: `sparseCheckout.${repo} must be an array of directories` };
    const result = validateSparseDirectories(directories);
    if (result.error) return result;
    if (result.value.length) entries.push([repo, result.value]);
  }
  return { value: entries.length ? Object.fromEntries(entries) : null };
};

// Git cone mode materializes every root file, everything below a selected
// directory, and the files directly inside each selected directory's
// ancestors. `filePath` is repository-relative with forward slashes.
export const isInSparseCone = (filePath, directories) => {
  const slash = filePath.lastIndexOf('/');
  if (slash < 0) return true;
  const parent = filePath.slice(0, slash);
  return directories.some(
    (dir) => parent === dir || parent.startsWith(`${dir}/`) || dir.startsWith(`${parent}/`),
  );
};
