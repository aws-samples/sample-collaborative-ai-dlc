// Real temporary files, modes, ownership, symlinks, renames and readback.
// Only the mount/proc view and full-width NFS inode IDs are simulated.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

const fixture = JSON.parse(await fs.readFile(process.env.NE02_FILESYSTEM_FIXTURE, 'utf8'));
const mapped = (path) => {
  for (const [prefix, target] of [
    ['/mnt/native', fixture.root],
    ['/proc', fixture.procRoot],
  ])
    if (path === prefix || path.startsWith(`${prefix}/`)) return target + path.slice(prefix.length);
  throw new Error('Generated command escaped the fixture');
};
const unmapped = (path) =>
  path === fixture.root || path.startsWith(`${fixture.root}/`)
    ? '/mnt/native' + path.slice(fixture.root.length)
    : path;
const metadata = (stat) => {
  const ino = fixture.inodes[String(stat.ino)];
  if (ino !== undefined)
    stat.ino = typeof stat.ino === 'bigint' ? new BigInt64Array([BigInt(ino)])[0] : Number(ino);
  stat.dev = typeof stat.dev === 'bigint' ? 45n : 45;
  return stat;
};
const writable = () => {
  if (fixture.readOnly) throw new Error('Inspection attempted to mutate its fixture');
};

export const lstat = async (path, options) => metadata(await fs.lstat(mapped(path), options));
export const realpath = async (path) => unmapped(await fs.realpath(mapped(path)));
export const readdir = (path, options) => fs.readdir(mapped(path), options);
export const readlink = (path) => fs.readlink(mapped(path));
export const statfs = async (path) => ({
  ...(await fs.statfs(mapped(path))),
  type: fixture.badMount ? 0xef53 : 0x6969,
});
export const readFile = (path, options) =>
  path === '/proc/self/mountinfo'
    ? Promise.resolve('51 30 0:45 / /mnt/native rw,relatime - nfs4 127.0.0.1:/ rw,vers=4.1\n')
    : fs.readFile(mapped(path), options);
export const open = async (path, flags, mode) => {
  if (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC))
    writable();
  const handle = await fs.open(mapped(path), flags, mode);
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'stat') return async (options) => metadata(await target.stat(options));
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};
export const mkdir = (path, options) => {
  writable();
  return fs.mkdir(mapped(path), options);
};
export const rename = (from, to) => {
  writable();
  return fs.rename(mapped(from), mapped(to));
};
