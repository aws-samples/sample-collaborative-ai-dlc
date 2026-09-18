import { describe, it, expect } from 'vitest';
import {
  sha256Hex,
  deriveSigningKey,
  signStringToSign,
  formatSigningTimestamp,
  codeCommitGitHost,
  codeCommitRepoPath,
  codeCommitCloneUrl,
  signCodeCommitGitCredential,
} from '../git-providers/codecommit-credential.js';

// Known-answer vector from the AWS documentation ("Example Signature
// Calculation", https://docs.aws.amazon.com/amazonglacier/latest/dev/amazon-glacier-signing-requests.html):
// demonstration secret key, verbatim canonical request, verbatim string to
// sign and the signature AWS states for them. This pins the SigV4 primitive
// (hash → string to sign → key derivation → HMAC) to AWS's own numbers.
const DOC_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const DOC_CANONICAL_REQUEST = [
  'PUT',
  '/-/vaults/examplevault',
  '',
  'host:glacier.us-east-1.amazonaws.com',
  'x-amz-date:20120525T002453Z',
  'x-amz-glacier-version:2012-06-01',
  '',
  'host;x-amz-date;x-amz-glacier-version',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
].join('\n');
const DOC_STRING_TO_SIGN = [
  'AWS4-HMAC-SHA256',
  '20120525T002453Z',
  '20120525/us-east-1/glacier/aws4_request',
  '5f1da1a2d0feb614dd03d71e87928b8e449ac87614479332aced3a701f916743',
].join('\n');
const DOC_SIGNATURE = '3ce5b2f2fffac9262b4da9256f8d086b4aaf42eba5f111c21681a65a127b7c2a';

describe('SigV4 primitive (AWS documentation known-answer vector)', () => {
  it('hashes the documented canonical request to the documented digest', () => {
    expect(sha256Hex(DOC_CANONICAL_REQUEST)).toBe(
      '5f1da1a2d0feb614dd03d71e87928b8e449ac87614479332aced3a701f916743',
    );
  });

  it('signs the documented string to sign to the documented signature', () => {
    expect(
      signStringToSign({
        secretAccessKey: DOC_SECRET,
        shortDate: '20120525',
        region: 'us-east-1',
        service: 'glacier',
        stringToSign: DOC_STRING_TO_SIGN,
      }),
    ).toBe(DOC_SIGNATURE);
  });

  it('derives a 32-byte signing key that changes with every scope component', () => {
    const base = { secretAccessKey: DOC_SECRET, shortDate: '20120525', region: 'us-east-1' };
    const key = deriveSigningKey({ ...base, service: 'codecommit' });
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(32);
    expect(deriveSigningKey({ ...base, service: 'glacier' }).equals(key)).toBe(false);
    expect(
      deriveSigningKey({ ...base, service: 'codecommit', region: 'eu-west-3' }).equals(key),
    ).toBe(false);
    expect(
      deriveSigningKey({ ...base, service: 'codecommit', shortDate: '20120526' }).equals(key),
    ).toBe(false);
  });
});

describe('formatSigningTimestamp', () => {
  it('formats UTC as YYYYMMDDTHHMMSS with no trailing Z', () => {
    expect(formatSigningTimestamp(new Date('2026-09-18T14:00:00.000Z'))).toBe('20260918T140000');
    expect(formatSigningTimestamp(new Date('2026-01-05T03:07:09.999Z'))).toBe('20260105T030709');
  });

  it('rejects an invalid date', () => {
    expect(() => formatSigningTimestamp(new Date('nope'))).toThrow(TypeError);
    expect(() => formatSigningTimestamp('2026-09-18')).toThrow(TypeError);
  });
});

describe('endpoint model', () => {
  it('builds the regional git host and clone URL', () => {
    expect(codeCommitGitHost('eu-west-3')).toBe('git-codecommit.eu-west-3.amazonaws.com');
    expect(codeCommitRepoPath('demo-repo')).toBe('/v1/repos/demo-repo');
    expect(codeCommitCloneUrl('eu-west-3', 'demo-repo')).toBe(
      'https://git-codecommit.eu-west-3.amazonaws.com/v1/repos/demo-repo',
    );
  });

  it('uses the China partition domain and the FIPS service name on request', () => {
    expect(codeCommitGitHost('cn-north-1')).toBe('git-codecommit.cn-north-1.amazonaws.com.cn');
    expect(codeCommitGitHost('us-east-1', { fips: true })).toBe(
      'git-codecommit-fips.us-east-1.amazonaws.com',
    );
  });

  it('rejects malformed regions and repository names', () => {
    expect(() => codeCommitGitHost('EU-WEST-3')).toThrow(/Invalid AWS region/);
    expect(() => codeCommitGitHost('eu-west')).toThrow(/Invalid AWS region/);
    expect(() => codeCommitGitHost('../x')).toThrow(/Invalid AWS region/);
    expect(() => codeCommitRepoPath('has space')).toThrow(/Invalid CodeCommit repository name/);
    expect(() => codeCommitRepoPath('a/b')).toThrow(/Invalid CodeCommit repository name/);
    expect(() => codeCommitRepoPath('repo.git')).toThrow(/Invalid CodeCommit repository name/);
    expect(() => codeCommitRepoPath('x'.repeat(101))).toThrow(/Invalid CodeCommit repository name/);
    expect(() => codeCommitRepoPath('')).toThrow(/Invalid CodeCommit repository name/);
  });
});

describe('signCodeCommitGitCredential', () => {
  const now = new Date('2026-09-18T14:00:00.000Z');
  const permanent = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: DOC_SECRET,
  };
  const temporary = { ...permanent, sessionToken: 'FwoGZXIvYXdzEXAMPLETOKEN' };

  it('emits the credential-helper shape: raw username, timestamp Z signature', () => {
    const cred = signCodeCommitGitCredential({
      region: 'eu-west-3',
      repositoryName: 'demo-repo',
      credentials: temporary,
      now,
    });
    expect(cred.username).toBe('AKIAIOSFODNN7EXAMPLE%FwoGZXIvYXdzEXAMPLETOKEN');
    expect(cred.password).toMatch(/^20260918T140000Z[0-9a-f]{64}$/);
    expect(cred.host).toBe('git-codecommit.eu-west-3.amazonaws.com');
    expect(cred.path).toBe('/v1/repos/demo-repo');
    expect(cred.cloneUrl).toBe('https://git-codecommit.eu-west-3.amazonaws.com/v1/repos/demo-repo');
    expect(cred.signedAt).toBe('20260918T140000');
    // The remote must never carry a credential.
    expect(cred.cloneUrl).not.toContain('@');
    expect(cred.cloneUrl).not.toContain(cred.password);
  });

  it('omits the session-token suffix for a long-lived key', () => {
    const cred = signCodeCommitGitCredential({
      region: 'eu-west-3',
      repositoryName: 'demo-repo',
      credentials: permanent,
      now,
    });
    expect(cred.username).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('is deterministic for identical inputs and bound to host, path, time and key', () => {
    const base = { region: 'eu-west-3', repositoryName: 'demo-repo', credentials: temporary, now };
    const a = signCodeCommitGitCredential(base).password;
    expect(signCodeCommitGitCredential(base).password).toBe(a);
    expect(signCodeCommitGitCredential({ ...base, repositoryName: 'other' }).password).not.toBe(a);
    expect(signCodeCommitGitCredential({ ...base, region: 'eu-west-1' }).password).not.toBe(a);
    expect(
      signCodeCommitGitCredential({ ...base, now: new Date('2026-09-18T14:00:01.000Z') }).password,
    ).not.toBe(a);
    expect(
      signCodeCommitGitCredential({
        ...base,
        credentials: { ...temporary, secretAccessKey: `${DOC_SECRET}x` },
      }).password,
    ).not.toBe(a);
  });

  it('reproduces the git-remote-codecommit construction step by step', () => {
    // Recompute the password by hand from the documented recipe:
    //   canonical = 'GIT\n<path>\n\nhost:<host>\n\nhost\n'
    //   sts       = 'AWS4-HMAC-SHA256\n<ts>\n<date>/<region>/codecommit/aws4_request\n<sha256(canonical)>'
    //   password  = '<ts>Z' + hmac(kSigning, sts)
    const region = 'eu-west-3';
    const host = 'git-codecommit.eu-west-3.amazonaws.com';
    const path = '/v1/repos/demo-repo';
    const ts = '20260918T140000';
    const canonical = `GIT\n${path}\n\nhost:${host}\n\nhost\n`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      ts,
      `20260918/${region}/codecommit/aws4_request`,
      sha256Hex(canonical),
    ].join('\n');
    const expected = `${ts}Z${signStringToSign({
      secretAccessKey: DOC_SECRET,
      shortDate: '20260918',
      region,
      service: 'codecommit',
      stringToSign,
    })}`;
    const cred = signCodeCommitGitCredential({
      region,
      repositoryName: 'demo-repo',
      credentials: temporary,
      now,
    });
    expect(cred.password).toBe(expected);
  });

  it('signs against the FIPS host when asked', () => {
    const cred = signCodeCommitGitCredential({
      region: 'us-east-1',
      repositoryName: 'demo-repo',
      credentials: temporary,
      now,
      fips: true,
    });
    expect(cred.host).toBe('git-codecommit-fips.us-east-1.amazonaws.com');
  });

  it('refuses incomplete credentials and bad targets before touching any key', () => {
    expect(() =>
      signCodeCommitGitCredential({
        region: 'eu-west-3',
        repositoryName: 'demo-repo',
        credentials: { accessKeyId: 'AKIA' },
      }),
    ).toThrow(/accessKeyId and secretAccessKey/);
    expect(() =>
      signCodeCommitGitCredential({
        region: 'eu-west-3',
        repositoryName: 'bad/name',
        credentials: temporary,
      }),
    ).toThrow(/Invalid CodeCommit repository name/);
    expect(() =>
      signCodeCommitGitCredential({
        region: 'nowhere',
        repositoryName: 'demo-repo',
        credentials: temporary,
      }),
    ).toThrow(/Invalid AWS region/);
  });
});
