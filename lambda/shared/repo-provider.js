// Resolve the git provider for a repo reference. A repo is either a plain URL
// string or an object ({ url, provider? }); `providers` is the intent meta's
// url→provider map and `fallback` the project-level default.
const repoUrl = (repo) => (typeof repo === 'string' ? repo : (repo?.url ?? ''));

const repoProvider = (repo, fallback, providers) =>
  (typeof repo === 'object' && repo?.provider) ||
  providers?.[repoUrl(repo)] ||
  fallback ||
  'github';

export { repoUrl, repoProvider };
export default { repoUrl, repoProvider };
