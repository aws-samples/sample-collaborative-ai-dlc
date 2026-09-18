// CodeCommit git credential signer.
//
// CodeCommit's HTTPS git endpoint does not take a bearer token. Instead the
// caller presents a SigV4 signature *as the HTTP Basic password*, with the
// access key (and session token, when temporary) as the username. This is the
// exact scheme implemented by `aws codecommit credential-helper` and by
// git-remote-codecommit (https://github.com/aws/git-remote-codecommit,
// `git_url()` + `sign()`): a canonical request of the form
//
//   GIT\n<path>\n\nhost:<hostname>\n\nhost\n
//
// signed with service `codecommit`, and a password of
// `<YYYYMMDD'T'HHMMSS>Z<hex signature>`. Note the timestamp inside the string to
// sign carries NO trailing `Z` (botocore's `request.context['timestamp']` is
// formatted `%Y%m%dT%H%M%S`); the `Z` is only the separator in the password.
//
// Because the result is a plain {username, password} pair, temporary STS
// credentials can travel through the credential broker and `git-auth.js`
// unchanged: nothing is written to disk, no CLI and no Python helper is needed
// in the AgentCore image, and the only secret ever materialised is a signature
// that is bound to one repository host + path and expires on its own.
import { createHash, createHmac } from 'node:crypto';

const SERVICE = 'codecommit';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const REPO_PATH_PREFIX = '/v1/repos/';

// Names: 1–100 chars of [A-Za-z0-9._-], cannot end in `.git`
// (https://docs.aws.amazon.com/codecommit/latest/userguide/limits.html).
const REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
// Region codes such as eu-west-3, us-gov-west-1, cn-north-1.
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

const hmac = (key, data, encoding) =>
  createHmac('sha256', key).update(data, 'utf8').digest(encoding);

export const sha256Hex = (data) => createHash('sha256').update(data, 'utf8').digest('hex');

// Standard SigV4 key derivation (kDate → kRegion → kService → kSigning).
export const deriveSigningKey = ({ secretAccessKey, shortDate, region, service }) => {
  const kDate = hmac(`AWS4${secretAccessKey}`, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
};

// HMAC of an already-built string to sign with the derived key, lowercase hex.
export const signStringToSign = ({ secretAccessKey, shortDate, region, service, stringToSign }) =>
  hmac(deriveSigningKey({ secretAccessKey, shortDate, region, service }), stringToSign, 'hex');

// `YYYYMMDD'T'HHMMSS` in UTC — no trailing `Z`, see header comment.
export const formatSigningTimestamp = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('signing timestamp requires a valid Date');
  }
  return date.toISOString().replace(/[-:]/g, '').slice(0, 15);
};

const partitionDomain = (region) =>
  region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';

// Regional git endpoint. FIPS endpoints exist only in a subset of US regions
// (https://docs.aws.amazon.com/codecommit/latest/userguide/regions.html);
// callers opt in explicitly rather than having it inferred.
export const codeCommitGitHost = (region, { fips = false } = {}) => {
  assertRegion(region);
  const service = fips ? 'git-codecommit-fips' : 'git-codecommit';
  return `${service}.${region}.${partitionDomain(region)}`;
};

export const codeCommitRepoPath = (repositoryName) => {
  assertRepositoryName(repositoryName);
  return `${REPO_PATH_PREFIX}${repositoryName}`;
};

export const codeCommitCloneUrl = (region, repositoryName, options) =>
  `https://${codeCommitGitHost(region, options)}${codeCommitRepoPath(repositoryName)}`;

const assertRegion = (region) => {
  if (typeof region !== 'string' || !REGION.test(region)) {
    throw new TypeError(`Invalid AWS region: ${String(region)}`);
  }
};

const assertRepositoryName = (name) => {
  if (typeof name !== 'string' || !REPOSITORY_NAME.test(name) || /\.git$/i.test(name)) {
    throw new TypeError('Invalid CodeCommit repository name');
  }
};

const assertCredentials = (credentials) => {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new TypeError('CodeCommit signing requires accessKeyId and secretAccessKey');
  }
};

// Produce the git username/password pair for one repository.
//
//   username = accessKeyId            (long-lived key)
//            | accessKeyId%sessionToken (temporary credentials)
//   password = <timestamp>Z<signature>
//
// The username is returned RAW (not URL-encoded): git hands it to libcurl for
// HTTP Basic auth, which is how `aws codecommit credential-helper` emits it
// over the git-credential protocol. Only a URL embedding (git-remote-codecommit
// style) needs percent-encoding, which `codeCommitCloneUrl` deliberately does
// not do — the remote must stay credential-free.
export const signCodeCommitGitCredential = ({
  region,
  repositoryName,
  credentials,
  now = new Date(),
  fips = false,
}) => {
  assertRegion(region);
  assertCredentials(credentials);
  const host = codeCommitGitHost(region, { fips });
  const path = codeCommitRepoPath(repositoryName);
  const timestamp = formatSigningTimestamp(now);
  const shortDate = timestamp.slice(0, 8);

  const canonicalRequest = `GIT\n${path}\n\nhost:${host}\n\nhost\n`;
  const credentialScope = `${shortDate}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, timestamp, credentialScope, sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const signature = signStringToSign({
    secretAccessKey: credentials.secretAccessKey,
    shortDate,
    region,
    service: SERVICE,
    stringToSign,
  });

  const username = credentials.sessionToken
    ? `${credentials.accessKeyId}%${credentials.sessionToken}`
    : credentials.accessKeyId;

  return {
    username,
    password: `${timestamp}Z${signature}`,
    host,
    path,
    cloneUrl: `https://${host}${path}`,
    signedAt: timestamp,
  };
};

export default {
  sha256Hex,
  deriveSigningKey,
  signStringToSign,
  formatSigningTimestamp,
  codeCommitGitHost,
  codeCommitRepoPath,
  codeCommitCloneUrl,
  signCodeCommitGitCredential,
};
