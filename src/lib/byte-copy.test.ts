import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFileBytes, copyTreeBytes } from './byte-copy.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-byte-copy-'));
  roots.push(root);
  return root;
}

/** Restore owner write and search on every directory so a read-only fixture can be removed. */
function makeRemovable(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeRemovable(join(path, name));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function codeOf(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

const ATIME = new Date('2021-02-03T04:05:06.789Z');
const MTIME = new Date('2020-01-02T03:04:05.678Z');

function file(path: string, bytes: string | Uint8Array, mode: number): void {
  writeFileSync(path, bytes);
  chmodSync(path, mode);
  utimesSync(path, ATIME, MTIME);
}

/** Bytes that cross the 1 MiB chunk boundary and are not one repeated value. */
function patterned(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + (index >> 11)) & 0xff;
  return bytes;
}

/** Every kind the payload trees can hold, with a distinct mode on each. */
function buildTree(root: string): void {
  mkdirSync(root);
  file(join(root, 'plain'), 'plain bytes\n', 0o640);
  file(join(root, 'tool'), '#!/bin/sh\nexit 0\n', 0o755);
  file(join(root, '.dotfile'), 'hidden\n', 0o600);
  file(join(root, 'empty'), '', 0o644);
  file(join(root, 'exact-chunk'), patterned(1024 * 1024), 0o644);
  file(join(root, 'large'), patterned(2 * 1024 * 1024 + 517), 0o644);
  mkdirSync(join(root, 'nested'));
  file(join(root, 'nested', 'inner'), 'inner\n', 0o644);
  symlinkSync('../plain', join(root, 'nested', 'relative-link'));
  symlinkSync('/nonexistent/genie-byte-copy-target', join(root, 'dangling-link'));
  symlinkSync('nested', join(root, 'directory-link'));
  chmodSync(join(root, 'nested'), 0o750);
  mkdirSync(join(root, 'empty-dir'));
  chmodSync(join(root, 'empty-dir'), 0o700);
  // Read-only: its entry can only be copied in if its mode is set after the entries, as cpSync did.
  mkdirSync(join(root, 'read-only'));
  file(join(root, 'read-only', 'kept'), 'kept\n', 0o444);
  chmodSync(join(root, 'read-only'), 0o555);
}

interface Entry {
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  size?: number;
  target?: string;
  atimeMs?: number;
  mtimeMs?: number;
}

/** Metadata only, never file bytes: reading a file before it is copied would move its atime. */
function describeTree(root: string, relative = ''): Entry[] {
  const path = relative ? join(root, relative) : root;
  const stat = lstatSync(path);
  const mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) return [{ path: relative, kind: 'symlink', mode: 0, target: readlinkSync(path) }];
  if (stat.isFile()) {
    return [{ path: relative, kind: 'file', mode, size: stat.size, atimeMs: stat.atimeMs, mtimeMs: stat.mtimeMs }];
  }
  const entries: Entry[] = [{ path: relative, kind: 'directory', mode }];
  for (const name of readdirSync(path).sort())
    entries.push(...describeTree(root, relative ? join(relative, name) : name));
  return entries;
}

describe('copyTreeBytes', () => {
  test('keeps every entry kind, its mode, its bytes, its link target and its file times', () => {
    const root = makeRoot();
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    buildTree(source);
    const expected = describeTree(source);

    copyTreeBytes(source, destination);

    expect(describeTree(destination)).toEqual(expected);
    // The times are the source's, not the copy's: cpSync's preserveTimestamps kept them to the millisecond.
    // Checked before any read below, which may move an atime.
    expect(lstatSync(join(destination, 'large')).mtime.getTime()).toBe(MTIME.getTime());
    expect(lstatSync(join(destination, 'large')).atime.getTime()).toBe(ATIME.getTime());
    for (const entry of expected.filter((each) => each.kind === 'file')) {
      expect(readFileSync(join(destination, entry.path))).toEqual(readFileSync(join(source, entry.path)));
    }
    // Links are recreated, never followed: the link to a directory did not become a second copy of it.
    expect(lstatSync(join(destination, 'directory-link')).isSymbolicLink()).toBe(true);
  });

  test('a top-level file or symlink is copied as itself', () => {
    const root = makeRoot();
    file(join(root, 'tool'), '#!/bin/sh\n', 0o755);
    symlinkSync('tool', join(root, 'link'));

    copyTreeBytes(join(root, 'tool'), join(root, 'tool-copy'));
    copyTreeBytes(join(root, 'link'), join(root, 'link-copy'));

    expect(lstatSync(join(root, 'tool-copy')).mode & 0o7777).toBe(0o755);
    expect(readFileSync(join(root, 'tool-copy'), 'utf8')).toBe('#!/bin/sh\n');
    expect(readlinkSync(join(root, 'link-copy'))).toBe('tool');
  });

  test('refuses an existing destination of every kind and changes nothing there', () => {
    const root = makeRoot();
    const source = join(root, 'source');
    buildTree(source);
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'sentinel'), 'safe\n');

    const existingDirectory = join(root, 'existing-directory');
    mkdirSync(existingDirectory);
    writeFileSync(join(existingDirectory, 'sentinel'), 'safe\n');
    expect(codeOf(() => copyTreeBytes(source, existingDirectory))).toBe('EEXIST');
    expect(readdirSync(existingDirectory)).toEqual(['sentinel']);

    const existingFile = join(root, 'existing-file');
    writeFileSync(existingFile, 'safe\n');
    expect(codeOf(() => copyTreeBytes(join(source, 'plain'), existingFile))).toBe('EEXIST');
    expect(readFileSync(existingFile, 'utf8')).toBe('safe\n');

    const linkToDirectory = join(root, 'link-to-victim');
    symlinkSync(victim, linkToDirectory);
    expect(codeOf(() => copyTreeBytes(source, linkToDirectory))).toBe('EEXIST');
    const linkToFile = join(root, 'link-to-sentinel');
    symlinkSync(join(victim, 'sentinel'), linkToFile);
    expect(codeOf(() => copyTreeBytes(join(source, 'plain'), linkToFile))).toBe('EEXIST');
    expect(readdirSync(victim)).toEqual(['sentinel']);
    expect(readFileSync(join(victim, 'sentinel'), 'utf8')).toBe('safe\n');

    const dangling = join(root, 'dangling');
    symlinkSync(join(victim, 'created-through-link'), dangling);
    expect(codeOf(() => copyTreeBytes(join(source, 'plain'), dangling))).toBe('EEXIST');
    expect(existsSync(join(victim, 'created-through-link'))).toBe(false);

    const existingLink = join(root, 'existing-link');
    symlinkSync('somewhere', existingLink);
    expect(codeOf(() => copyTreeBytes(join(source, 'dangling-link'), existingLink))).toBe('EEXIST');
    expect(readlinkSync(existingLink)).toBe('somewhere');
  });

  test.skipIf(process.getuid?.() === 0)(
    'a source that cannot be read fails the copy before its destination file is created',
    () => {
      const root = makeRoot();
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      mkdirSync(source);
      file(join(source, 'readable'), 'readable\n', 0o644);
      file(join(source, 'unreadable'), 'secret\n', 0o000);

      expect(codeOf(() => copyTreeBytes(source, destination))).toBe('EACCES');

      // What was copied before the failure stays, as with cpSync; the failing file has no partial copy.
      expect(existsSync(join(destination, 'unreadable'))).toBe(false);
      expect(readdirSync(destination).every((name) => name === 'readable')).toBe(true);
    },
  );

  test('refuses an entry that is not a file, directory or symlink', () => {
    const root = makeRoot();
    const source = join(root, 'source');
    mkdirSync(source);
    const fifo = Bun.spawnSync(['mkfifo', join(source, 'fifo')]);
    expect(fifo.exitCode).toBe(0);
    expect(() => copyTreeBytes(source, join(root, 'destination'))).toThrow('files, directories and symlinks only');
    expect(existsSync(join(root, 'destination', 'fifo'))).toBe(false);
  });
});

describe('copyFileBytes', () => {
  test('without exclusive, overwrites an existing file entirely and takes the source mode, as copyFileSync did', () => {
    const root = makeRoot();
    file(join(root, 'source'), 'new\n', 0o750);
    writeFileSync(join(root, 'destination'), 'a much longer old content that must not survive\n', { mode: 0o600 });

    copyFileBytes(join(root, 'source'), join(root, 'destination'), { exclusive: false });

    expect(readFileSync(join(root, 'destination'), 'utf8')).toBe('new\n');
    expect(lstatSync(join(root, 'destination')).mode & 0o7777).toBe(0o750);
  });

  test('without exclusive, refuses a symlink at the destination instead of writing through it', () => {
    // copyFileSync followed such a link: it rewrote the target, and created a dangling link's target.
    const root = makeRoot();
    file(join(root, 'source'), 'new\n', 0o644);
    writeFileSync(join(root, 'victim'), 'safe\n');
    symlinkSync(join(root, 'victim'), join(root, 'link'));
    symlinkSync(join(root, 'never-created'), join(root, 'dangling'));

    expect(codeOf(() => copyFileBytes(join(root, 'source'), join(root, 'link'), { exclusive: false }))).toBe('ELOOP');
    expect(codeOf(() => copyFileBytes(join(root, 'source'), join(root, 'dangling'), { exclusive: false }))).toBe(
      'ELOOP',
    );

    expect(readFileSync(join(root, 'victim'), 'utf8')).toBe('safe\n');
    expect(lstatSync(join(root, 'link')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, 'never-created'))).toBe(false);
  });

  test('without exclusive, refuses to copy a file onto itself instead of truncating it', () => {
    const root = makeRoot();
    file(join(root, 'source'), 'kept\n', 0o644);
    linkSync(join(root, 'source'), join(root, 'hard-link'));

    expect(() => copyFileBytes(join(root, 'source'), join(root, 'hard-link'), { exclusive: false })).toThrow(
      'same file',
    );
    expect(readFileSync(join(root, 'source'), 'utf8')).toBe('kept\n');
  });

  test('never follows a symlink at the source, and creates no destination', () => {
    const root = makeRoot();
    file(join(root, 'target'), 'bytes\n', 0o644);
    symlinkSync(join(root, 'target'), join(root, 'link'));

    for (const exclusive of [true, false]) {
      const destination = join(root, `copy-${exclusive}`);
      expect(codeOf(() => copyFileBytes(join(root, 'link'), destination, { exclusive }))).toBe('ELOOP');
      expect(existsSync(destination)).toBe(false);
    }
  });

  test('keeps file times only when asked', () => {
    const root = makeRoot();
    file(join(root, 'source'), 'bytes\n', 0o644);

    copyFileBytes(join(root, 'source'), join(root, 'kept'), { exclusive: true, preserveTimestamps: true });
    copyFileBytes(join(root, 'source'), join(root, 'fresh'), { exclusive: true });

    expect(lstatSync(join(root, 'kept')).mtime.getTime()).toBe(MTIME.getTime());
    expect(lstatSync(join(root, 'fresh')).mtime.getTime()).not.toBe(MTIME.getTime());
  });
});
