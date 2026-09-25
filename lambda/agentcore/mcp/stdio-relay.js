// Deliberately has no AWS/application imports and accepts no scope or command.
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';

export const relayStdio = (socketPath, { input = process.stdin, output = process.stdout } = {}) => {
  const socket = connect(socketPath);
  input.pipe(socket);
  socket.pipe(output);
  input.on('end', () => socket.end());
  return socket;
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const socket = relayStdio(process.argv[2]);
  socket.on('error', () => {
    process.exitCode = 1;
    process.stdin.destroy();
  });
  socket.on('close', () => process.stdin.destroy());
}
