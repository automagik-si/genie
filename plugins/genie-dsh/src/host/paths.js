import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Resolve symlinks in the existing prefix, including when the final path has not been made. */
export function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}

export function within(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Only ENOENT proves absence. */
export function lstat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

export const sameInode = (a, b) => a != null && b != null && a.dev === b.dev && a.ino === b.ino;
