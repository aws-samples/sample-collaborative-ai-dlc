// The workspace storage of native intents: an EFS access point that AgentCore
// mounts into every session of the runtime at /mnt/aidlc, when the deployment
// has it (terraform/modules/compute/agentcore/native-workspace-storage.tf).
//
// AgentCore attaches the mount with the invocation, not at container start, so
// whether it is there is asked per call and never cached at boot.

import { constants } from 'node:fs';
import { access, statfs } from 'node:fs/promises';

export const NATIVE_WORKSPACE_ROOT = '/mnt/aidlc';

// statfs f_type of an NFS mount (NFS_SUPER_MAGIC). EFS is mounted over NFS.
const NFS_SUPER_MAGIC = 0x6969;

// True when the storage is mounted at the root and the runtime's user may write
// there. This asks for the permission and writes nothing. A runtime without the
// storage has no directory there, or a directory of the image or of another
// file system; neither counts.
export const nativeWorkspaceAvailable = async ({
  root = NATIVE_WORKSPACE_ROOT,
  inspectFilesystem = statfs,
  checkAccess = access,
} = {}) => {
  try {
    const filesystem = await inspectFilesystem(root);
    if (Number(filesystem.type) !== NFS_SUPER_MAGIC) return false;
    await checkAccess(root, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
