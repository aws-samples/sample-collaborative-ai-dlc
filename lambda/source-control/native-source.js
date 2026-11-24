import { isDeepStrictEqual } from 'node:util';
import { getBinding, canonicalRepo, ACTIVE } from '../shared/source-control-bindings.js';
import { getGitConnection, assertCurrentGitConnection } from '../shared/git-connection-store.js';
import { resolveBindingCredential } from '../shared/source-control-credentials.js';
import { workflowSourceIdentity } from '../shared/workflow-source-bindings.js';
import { nativeGitResultBranch } from '../shared/native-git-change-set.js';
import { resolveNativeSourceCommit } from '../shared/native-application-source.js';
import { sourceCredentialIdentity } from '../shared/source-credential-identity.js';

const denied = () =>
  Object.assign(new Error('Source selection changed or is unavailable'), {
    code: 'NATIVE_SOURCE_UNAVAILABLE',
  });
// Internal admission read, at the existing provider/credential owner. Returning
// metadata never delegates the source-control credential to the public router.
export const captureNativeSource = async ({
  input,
  ddb,
  ssm,
  secrets,
  membership,
  repositories,
  resolveCommit = resolveNativeSourceCommit,
  metadataOnly = false,
  deliveryRef = false,
}) => {
  const { projectId, userId, provider, repository, bindingRevision } = input;
  workflowSourceIdentity(provider, repository);
  const assertAccess = async () => {
    if (
      !['owner', 'admin', 'member'].includes(await membership(userId)) ||
      !(await repositories()).some(
        (repo) =>
          repo.provider === provider &&
          canonicalRepo(provider, repo.repo) === canonicalRepo(provider, repository),
      )
    )
      throw denied();
  };
  await assertAccess();
  const binding = await getBinding(ddb, projectId, provider, repository);
  if (
    !binding ||
    binding.status !== ACTIVE ||
    (!metadataOnly && binding.revision !== bindingRevision) ||
    binding.purpose === 'workflow-source'
  )
    throw denied();
  const oauth = binding.authType !== 'github-app';
  if (oauth && !['owner', 'admin', 'member'].includes(await membership(binding.connectionUserId)))
    throw denied();
  const connection = oauth ? await getGitConnection(ddb, binding.connectionUserId, provider) : null;
  if (oauth && !connection) throw denied();
  const credentialIdentity = sourceCredentialIdentity(binding, connection);
  if (
    deliveryRef &&
    (input.credentialIdentity !== credentialIdentity || binding.revision !== bindingRevision)
  )
    throw denied();
  const credential = await resolveBindingCredential({
    ddb,
    ssm,
    secrets,
    binding,
    requiredAccess: 'read',
  });
  const source = metadataOnly
    ? {}
    : await resolveCommit({
        provider,
        repository,
        token: credential.token,
        ...(deliveryRef
          ? {
              branch: nativeGitResultBranch(input.executionId, input.sourceBranch),
              allowMissing: true,
            }
          : {}),
      });
  await assertAccess();
  if (oauth) {
    if (!['owner', 'admin', 'member'].includes(await membership(binding.connectionUserId)))
      throw denied();
    await assertCurrentGitConnection(ddb, connection);
  }
  if (!isDeepStrictEqual(binding, await getBinding(ddb, projectId, provider, repository)))
    throw denied();
  return {
    ...source,
    bindingRevision: binding.revision,
    credentialIdentity,
  };
};
