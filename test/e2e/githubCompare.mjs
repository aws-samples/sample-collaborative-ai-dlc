// test/e2e/githubCompare.mjs
export async function aheadBy({ token, owner, repo, base, head }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aidlc-e2e-harness',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return 0; // branch missing => no commits ahead
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`compare ${owner}/${repo} ${base}...${head} -> ${res.status}: ${t}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.ahead_by ?? 0;
}
