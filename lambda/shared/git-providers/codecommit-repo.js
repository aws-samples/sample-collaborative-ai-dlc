// CodeCommit repository identity.
//
// GitHub/GitLab/Bitbucket identify a repository as `owner/name` on one global
// host. CodeCommit has a flat namespace per (partition, region, account), and
// its git endpoint is regional, so the platform's `repoId` for CodeCommit is
// the repository ARN:
//
//   arn:aws:codecommit:eu-west-3:123456789012:my-repo
//
// This module is the single parser/formatter for that shape. It accepts the
// ARN itself or the HTTPS clone URL (region + name only — the account is then
// unknown, which the caller must reject or complete), and never lowercases the
// repository name: CodeCommit names are matched exactly.
const ARN =
  /^arn:(aws|aws-cn|aws-us-gov):codecommit:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([A-Za-z0-9._-]{1,100})$/;
const CLONE_URL =
  /^https:\/\/git-codecommit(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com(?:\.cn)?\/v1\/repos\/([A-Za-z0-9._-]{1,100})\/?$/i;

const invalid = (value) =>
  Object.assign(new Error(`Invalid CodeCommit repository reference: ${String(value)}`), {
    code: 'INVALID_REPOSITORY',
  });

const partitionFor = (region) => {
  if (region.startsWith('cn-')) return 'aws-cn';
  if (region.startsWith('us-gov-')) return 'aws-us-gov';
  return 'aws';
};

export const codeCommitRepoArn = ({ region, accountId, repositoryName }) =>
  `arn:${partitionFor(region)}:codecommit:${region}:${accountId}:${repositoryName}`;

// Parse a repoId. Returns { arn, partition, region, accountId, repositoryName }.
// `accountId` is null when only a clone URL was given.
export const parseCodeCommitRepo = (value) => {
  const raw = String(value ?? '').trim();
  const arn = ARN.exec(raw);
  if (arn) {
    const [, partition, region, accountId, repositoryName] = arn;
    if (/\.git$/i.test(repositoryName)) throw invalid(value);
    return { arn: raw, partition, region, accountId, repositoryName };
  }
  const url = CLONE_URL.exec(raw);
  if (url) {
    const [, regionRaw, repositoryName] = url;
    const region = regionRaw.toLowerCase();
    if (/\.git$/i.test(repositoryName)) throw invalid(value);
    return { arn: null, partition: partitionFor(region), region, accountId: null, repositoryName };
  }
  throw invalid(value);
};

export const isCodeCommitRepoArn = (value) => ARN.test(String(value ?? '').trim());

// Canonical form used as the binding key: the ARN, verbatim. A clone URL
// cannot be canonicalised (no account) and is rejected here on purpose.
export const canonicalCodeCommitRepo = (value) => {
  const parsed = parseCodeCommitRepo(value);
  if (!parsed.arn) throw invalid(value);
  return parsed.arn;
};

export default {
  codeCommitRepoArn,
  parseCodeCommitRepo,
  isCodeCommitRepoArn,
  canonicalCodeCommitRepo,
};
