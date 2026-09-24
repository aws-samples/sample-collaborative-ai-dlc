import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INFERENCE_CREDENTIAL_ENV } from '../cli/environment.js';

// The CLI only speaks MCP over an invocation-scoped socket. The runtime starts
// the actual server with its application identity and immutable trusted scope.
// Same-UID processes are not a host sandbox; this boundary prevents accidental
// credential forwarding, not arbitrary hostile native code on the host.
export const createRuntimeMcpBridge = async ({
  entry,
  trustedEnv,
  runtimeEnv = process.env,
  spawnFn = spawn,
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aidlc-mcp-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'bridge.sock');
  const children = new Set();
  const sockets = new Set();
  const serverEnv = { ...runtimeEnv, ...trustedEnv };
  for (const key of INFERENCE_CREDENTIAL_ENV) delete serverEnv[key];
  const server = createServer((socket) => {
    sockets.add(socket);
    let child;
    try {
      child = spawnFn(process.execPath, [entry], {
        env: serverEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
    } catch {
      socket.destroy();
      return;
    }
    children.add(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.on('error', () => socket.destroy());
    child.stdin.on('error', () => socket.destroy());
    child.stdout.on('error', () => socket.destroy());
    child.on('error', () => socket.destroy());
    child.on('close', () => {
      children.delete(child);
      socket.destroy();
    });
    socket.on('close', () => {
      sockets.delete(socket);
      child.kill('SIGTERM');
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return {
    socketPath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill('SIGKILL');
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
};
