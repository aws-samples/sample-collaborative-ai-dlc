// The platform CodeCommit connection: one role the platform assumes for every
// space, set by a platform admin (issue #531). It replaces the per-user
// external-ID connection: the external ID is now a single per-deployment value
// in the Lambda env (CODECOMMIT_EXTERNAL_ID), and only the role ARN and region
// are stored, in an SSM String parameter named by CODECOMMIT_CONNECTION_PARAM.
//
//   value "{}"               not configured yet (the Terraform initial value)
//   value {roleArn, region}  the connection an admin saved
//
// Unlike getGitHubAppConfig (github-auth-config.js:26-33), which swallows an
// SSM error and reports "not configured", this reader FAILS CLOSED: a failed
// read throws, so a transient SSM problem surfaces as a 5xx and never lets a
// bind or a status call pretend the connection is absent (which would silently
// drop the role an admin set). There is no cache either, so a bind made right
// after the admin PUT already sees the new role.

import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { isCodeCommitRoleArn } from './codecommit-role.js';
import { isSupportedCodeCommitRegion } from './git-providers/codecommit-credential.js';

const paramName = () => process.env.CODECOMMIT_CONNECTION_PARAM;

// The per-deployment external ID the whole platform presents. Minted once by
// Terraform (random_uuid) and injected as an env var; never written by the app.
export const platformExternalId = () => String(process.env.CODECOMMIT_EXTERNAL_ID || '').trim();

const EMPTY = Object.freeze({ roleArn: null, region: null });

// { roleArn, region } for the saved connection, or { roleArn: null, region:
// null } when the parameter is still the initial "{}". A missing env var is a
// deployment error, not "not configured": throw so it is visible. An SSM read
// error is rethrown unchanged — the caller maps it to a 5xx.
export const getCodeCommitConnection = async (ssm) => {
  const name = paramName();
  if (!name) throw new Error('CODECOMMIT_CONNECTION_PARAM env var is required');
  const result = await ssm.send(new GetParameterCommand({ Name: name }));
  let parsed;
  try {
    parsed = JSON.parse(result.Parameter?.Value || '{}');
  } catch {
    // A corrupt parameter is a platform fault, not "not configured".
    throw new Error('CodeCommit connection parameter is not valid JSON');
  }
  const roleArn = isCodeCommitRoleArn(parsed?.roleArn) ? String(parsed.roleArn).trim() : null;
  const region = isSupportedCodeCommitRegion(parsed?.region) ? parsed.region : null;
  // The connection is usable only when both halves are present and valid.
  if (!roleArn || !region) return { ...EMPTY };
  return { roleArn, region };
};

// Overwrite the connection. Last writer wins (the Terraform parameter carries
// ignore_changes = [value], so the app owns the value after creation).
export const writeCodeCommitConnection = async (ssm, { roleArn, region }) => {
  const name = paramName();
  if (!name) throw new Error('CODECOMMIT_CONNECTION_PARAM env var is required');
  await ssm.send(
    new PutParameterCommand({
      Name: name,
      Value: JSON.stringify({ roleArn, region }),
      Type: 'String',
      Overwrite: true,
    }),
  );
};

export default {
  platformExternalId,
  getCodeCommitConnection,
  writeCodeCommitConnection,
};
