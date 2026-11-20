// Neutral committer identity, passed per-command via `-c` so the repo config
// is never mutated (and the agent can't inherit it for its own commits).
const DEFAULT_COMMITTER = {
  name: 'AI-DLC Engine',
  email: 'aidlc-engine@noreply.local',
};

// "On behalf of" attribution: when the orchestrator supplies the starting
// starter's snapshotted identity ({ name, email }), engine commits and merges
// are AUTHORED by the starter while the COMMITTER is the delegated OAuth or
// GitHub App identity returned by the broker. Implemented via
// `-c author.name/author.email` (git >=2.22):
// unlike `--author` it works for `merge` too, and unlike GIT_AUTHOR_* env it
// survives the shared runner's environment sanitization (which strips ambient
// overrides so the agent can't spoof authorship).
//
// Fields are sanitized to a valid git ident (no newlines/angle brackets); an
// unusable identity falls back to the engine-only identity — attribution is
// cosmetic, a commit must never fail over it.
const sanitizeIdentField = (v) => (typeof v === 'string' ? v.replace(/[<>\n\r]/g, ' ').trim() : '');

export const gitIdentity = (author = null, committer = null) => {
  const committerName = sanitizeIdentField(committer?.name) || DEFAULT_COMMITTER.name;
  const committerEmail = sanitizeIdentField(committer?.email) || DEFAULT_COMMITTER.email;
  const identity = ['-c', `user.email=${committerEmail}`, '-c', `user.name=${committerName}`];
  const authorName = sanitizeIdentField(author?.name);
  const authorEmail = sanitizeIdentField(author?.email);
  if (!authorName || !authorEmail) return identity;
  return [...identity, '-c', `author.name=${authorName}`, '-c', `author.email=${authorEmail}`];
};
