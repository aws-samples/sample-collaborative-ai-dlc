import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export const managedRuntimeCheck = async (payload, deps = {}) => {
  const workspaceDir = deps.workspaceDir ?? process.env.V2_WORKSPACE_DIR ?? '/mnt/workspace';
  const runtimeFile = deps.runtimeFile ?? '/opt/agentcore/http-server.js';
  const compatibilityVersion =
    deps.compatibilityVersion ?? process.env.RUNTIME_COMPATIBILITY_VERSION ?? '1';
  let workspaceWritable = false;
  let protectedRuntime = false;
  try {
    await access(workspaceDir, constants.W_OK);
    workspaceWritable = true;
  } catch {
    workspaceWritable = false;
  }
  try {
    await access(runtimeFile, constants.R_OK);
    protectedRuntime = true;
  } catch {
    protectedRuntime = false;
  }
  return {
    ok: workspaceWritable && protectedRuntime,
    nonce: payload?.nonce ?? null,
    compatibilityVersion,
    nonRoot: typeof process.getuid !== 'function' || process.getuid() !== 0,
    workspaceWritable,
    protectedRuntime,
  };
};

export default { managedRuntimeCheck };
