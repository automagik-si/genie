/**
 * Plain byte copies for the install and update paths.
 *
 * `cpSync` and `copyFileSync` ask the kernel for an in-kernel copy or a clone first. On a
 * copy-on-write filesystem, a clone of blocks written moments earlier can wait for those pending
 * writes to reach disk, tens of seconds under host write load (#3323). Install and update copy trees
 * they have just extracted or just promoted, so they copy here instead, by reading and writing bytes.
 *
 * Links are never followed on either side. A file is opened `O_NOFOLLOW` at the source and at the
 * destination, so a symlink swapped in after the caller's `lstat` fails the copy with `ELOOP` instead
 * of being read or written through. A copy that fails part-way leaves what it wrote so far, as
 * `cpSync` and `copyFileSync` did. Cleanup belongs to the caller's own failure path.
 */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const CHUNK_BYTES = 1024 * 1024;

export interface CopyFileBytesOptions {
  /**
   * `true` refuses an existing destination of any kind (`O_EXCL`, `EEXIST`). `false` overwrites an
   * existing regular file, as `copyFileSync` does, but refuses a symlink there with `ELOOP` where
   * `copyFileSync` wrote through it to its target.
   */
  exclusive: boolean;
  /** Set the destination's atime and mtime from the source, at the millisecond precision `cpSync` kept. */
  preserveTimestamps?: boolean;
}

/**
 * Copy one regular file by reading and writing its bytes. The destination ends with the source's
 * permission bits (`mode & 0o7777`), whatever the umask.
 */
export function copyFileBytes(source: string, destination: string, options: CopyFileBytesOptions): void {
  // O_NONBLOCK: a FIFO swapped in after the caller's lstat must not block the open; fstat refuses it below.
  const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(sourceFd);
    if (!stat.isFile()) throw new Error(`byte copy reads regular files only: ${source}`);
    const flags = options.exclusive
      ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
      : constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;
    const destinationFd = openSync(destination, flags, stat.mode & 0o7777);
    try {
      if (!options.exclusive) {
        const existing = fstatSync(destinationFd);
        if (existing.dev === stat.dev && existing.ino === stat.ino) {
          throw new Error(`byte copy source and destination are the same file: ${source}`);
        }
        ftruncateSync(destinationFd, 0);
      }
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const read = readSync(sourceFd, buffer, 0, CHUNK_BYTES, position);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(destinationFd, buffer, written, read - written);
        position += read;
      }
      fchmodSync(destinationFd, stat.mode & 0o7777);
      if (options.preserveTimestamps) futimesSync(destinationFd, stat.atime, stat.mtime);
    } finally {
      closeSync(destinationFd);
    }
  } finally {
    closeSync(sourceFd);
  }
}

/**
 * Copy a file, symlink or directory tree by bytes, keeping what install promotion's
 * `cpSync(source, destination, { recursive: true, force: false, errorOnExist: true,
 * preserveTimestamps: true, dereference: false, verbatimSymlinks: true })` kept:
 *
 * - an existing destination is refused at every level (`EEXIST`), never merged or overwritten;
 * - a regular file keeps its bytes, its permission bits, and its atime and mtime to the millisecond;
 * - a directory keeps its permission bits, set after its entries are copied, so a read-only source
 *   directory still receives them; as with `cpSync`, directory times are not kept;
 * - a symlink is recreated as a link with its target string verbatim, never followed;
 * - any other kind of entry (FIFO, socket, device) is refused.
 *
 * Unlike `cpSync`, missing parents of `destination` are not created. A relative path resolves against
 * the kernel working directory, which install promotion binds to its held staging directory.
 */
export function copyTreeBytes(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination);
  } else if (stat.isDirectory()) {
    mkdirSync(destination);
    for (const name of readdirSync(source)) copyTreeBytes(join(source, name), join(destination, name));
    const directoryFd = openSync(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fchmodSync(directoryFd, stat.mode & 0o7777);
    } finally {
      closeSync(directoryFd);
    }
  } else if (stat.isFile()) {
    copyFileBytes(source, destination, { exclusive: true, preserveTimestamps: true });
  } else {
    throw new Error(`byte copy handles files, directories and symlinks only: ${source}`);
  }
}
