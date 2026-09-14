const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const REPO = 'awslabs/aidlc-workflows';

const isCommitSha = (ref) => COMMIT_SHA_RE.test(String(ref ?? '').trim());

// Resolve a supported branch, tag, or SHA to the immutable commit used by an intent.
const resolveAidlcRepoRef = async (ref, { fetchFn = fetch } = {}) => {
  const value = String(ref ?? '').trim();
  if (!value) throw new Error('AI-DLC repository ref is not configured');
  if (isCommitSha(value)) return value.toLowerCase();

  const response = await fetchFn(
    `https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(value)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'sample-collaborative-ai-dlc',
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Unable to resolve AI-DLC repository ref "${value}" (${response.status})`);
  }
  const body = await response.json();
  if (!isCommitSha(body?.sha)) {
    throw new Error(`AI-DLC repository ref "${value}" did not resolve to a commit SHA`);
  }
  return body.sha.toLowerCase();
};

export { isCommitSha, resolveAidlcRepoRef };
