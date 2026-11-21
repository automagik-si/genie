// Copy-owned config is parsed as data before Git is allowed to open the repository.
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { BORROWED_TAGS, NO_PUSH_URL, run, storeFor } from './git.js';
import { lstat, sameInode, within } from './paths.js';

export const IDLE_MS = 30 * 60_000;
// A large tree's status or index listing outgrows run()'s defaults; a timeout only keeps a copy.
const LIMITS = { timeout: 5 * 60_000, maxBuffer: 256 * 1024 * 1024 };
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const branchFetch = (name) => `+refs/heads/*:refs/remotes/${name}/*`;

export function inspectionGit(home) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    LC_ALL: 'C',
  };
  const flags = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false'];
  return (args, cwd, folder) => {
    const target = folder === undefined ? [] : [`--git-dir=${join(folder, '.git')}`, `--work-tree=${folder}`];
    return run('git', [...flags, ...target, ...args], { cwd: cwd ?? home, env, replaceEnv: true, ...LIMITS });
  };
}

function configEntries(stdout) {
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const split = line.indexOf('\n');
      return split === -1 ? [line, undefined] : [line.slice(0, split), line.slice(split + 1)];
    });
}

export async function configOf(git, file) {
  if (!lstat(file)?.isFile()) return null;
  const result = await git(['config', '--file', file, '--no-includes', '--null', '--list']);
  return result.ok ? configEntries(result.stdout) : null;
}

function allowedConfig(key, value, repo) {
  switch (key) {
    case 'core.repositoryformatversion':
      return value === '0' || value === '1';
    case 'core.bare':
      return value === 'false';
    case 'core.filemode':
    case 'core.logallrefupdates':
    case 'core.ignorecase':
    case 'core.precomposeunicode':
    case 'core.symlinks':
      return value === 'true' || value === 'false';
    case 'remote.origin.url':
      return value === repo;
    case 'remote.origin.pushurl':
      return value === NO_PUSH_URL;
    case 'remote.origin.fetch':
      return value === branchFetch('origin');
    case 'remote.publish.fetch':
      return value === branchFetch('publish');
    case 'remote.publish.url':
    case 'user.name':
    case 'user.email':
      return typeof value === 'string';
    case 'credential.helper':
      return value === '';
    case 'extensions.objectformat':
      return value === 'sha1' || value === 'sha256';
    default:
      if (/^branch\..+\.remote$/.test(key)) return ['origin', 'publish', '.'].includes(value);
      return /^branch\..+\.merge$/.test(key) && value?.startsWith('refs/heads/');
  }
}

async function copyConfig(git, gitDir, repo) {
  const entries = await configOf(git, join(gitDir, 'config'));
  if (entries === null) return 'unreadable';
  for (const [key, value] of entries) {
    if (!allowedConfig(key, value, repo)) return `config:${key}`;
  }
  for (const key of ['remote.origin.url', 'remote.origin.pushurl']) {
    if (entries.filter(([name]) => name === key).length !== 1) return `config:${key}`;
  }
  return null;
}

/** Filesystem-only. Never open Git in the candidate before configOf has validated its config. */
function identity(folder, root, repo, home) {
  const stat = lstat(folder);
  if (!stat?.isDirectory() || !within(root, folder) || realpathSync(folder) !== folder) return { keep: 'not-a-copy' };
  const uid = process.getuid?.();
  const gitDir = join(folder, '.git');
  const gitStat = lstat(gitDir);
  if (!gitStat?.isDirectory()) return { keep: 'not-a-copy' };
  if (uid !== undefined && (stat.uid !== uid || gitStat.uid !== uid)) return { keep: 'unsupported:owner' };
  for (const [path, reason] of [
    [join(gitDir, 'commondir'), 'worktrees'],
    [join(gitDir, 'worktrees'), 'worktrees'],
    [join(gitDir, 'config.worktree'), 'worktree-config'],
    [join(gitDir, 'modules'), 'submodules'],
    [join(folder, '.gitmodules'), 'submodules'],
    [join(gitDir, 'info', 'grafts'), 'grafts'],
    // An operation stopped half way holds work no ref or status shows.
    ...['rebase-apply', 'rebase-merge', 'sequencer', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'].map(
      (name) => [join(gitDir, name), 'in-progress'],
    ),
  ]) {
    if (lstat(path)) return { keep: `unsupported:${reason}` };
  }
  const objects = join(gitDir, 'objects');
  if (!lstat(objects)?.isDirectory() || realpathSync(objects) !== objects) return { keep: 'unreadable' };
  const alternate = join(objects, 'info', 'alternates');
  const altStat = lstat(alternate);
  if (altStat) {
    const store = join(storeFor(home, repo), 'objects');
    if (
      !altStat.isFile() ||
      realpathSync(alternate) !== alternate ||
      readFileSync(alternate, 'utf8') !== `${store}\n`
    ) {
      return { keep: 'unsupported:alternates' };
    }
    if (realpathSync(store) !== store || lstat(join(store, 'info', 'alternates'))) return { keep: 'unreadable' };
  }
  return { stat, gitDir, gitStat };
}

function inspectTree(folder, gitDir) {
  let newest = 0;
  let bytes = 0;
  const stack = [folder];
  while (stack.length > 0) {
    const path = stack.pop();
    const stat = lstatSync(path);
    if (within(gitDir, path) && path.endsWith('.lock')) return { keep: `locked:${path.slice(gitDir.length + 1)}` };
    newest = Math.max(newest, stat.mtimeMs);
    bytes += stat.size;
    if (stat.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name));
  }
  return { newest, bytes };
}

async function clean(git) {
  const flags = await git(['ls-files', '-v', '-z']);
  if (!flags.ok) return 'unreadable';
  if (flags.stdout.split('\0').some((line) => /^[a-zS] /.test(line))) return 'unsupported:index-flags';
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (!status.ok) return 'unreadable';
  return status.stdout ? 'dirty' : null;
}

/** Resolve relative and chained alternates before trusting project connectivity. */
function independentObjects(path, root, seen = new Set()) {
  const objects = realpathSync(path);
  const alternates = join(objects, 'info', 'alternates');
  if (within(root, objects) || within(root, canonicalAlternatePath(alternates))) return false;
  if (seen.has(objects)) return true;
  seen.add(objects);
  // A project pack or loose object reachable only through a symlink into the copy
  // is just as dependent as an alternate. Promisor markers can suppress fsck errors.
  if (!standaloneObjectFiles(objects)) return false;
  const stat = lstat(alternates);
  if (!stat) return true;
  if (!stat.isFile()) return false;
  return readFileSync(alternates, 'utf8')
    .split('\n')
    .filter(Boolean)
    .every((other) => {
      if (other.startsWith('"')) return false; // Quoted alternate paths are not needed by Genie.
      return independentObjects(resolve(objects, other), root, seen);
    });
}

function standaloneObjectFiles(objects) {
  for (const item of readdirSync(objects, { withFileTypes: true })) {
    if (item.isSymbolicLink()) return false;
    if (!item.isDirectory() || !/^(pack|[0-9a-f]{2})$/.test(item.name)) continue;
    const directory = join(objects, item.name);
    if (
      readdirSync(directory, { withFileTypes: true }).some((entry) => {
        return entry.isSymbolicLink() || entry.name.endsWith('.promisor');
      })
    )
      return false;
  }
  return true;
}

function canonicalAlternatePath(path) {
  return lstat(path) ? realpathSync(path) : path;
}

async function verifiableProject(git, root) {
  const shallow = await git(['rev-parse', '--is-shallow-repository']);
  if (!shallow.ok || shallow.stdout !== 'false') return false;
  const config = await git(['config', '--null', '--list']);
  const partialClone = /^(extensions\.partialclone|remote\..+\.(promisor|partialclonefilter))$/;
  if (!config.ok || configEntries(config.stdout).some(([key]) => partialClone.test(key))) return false;
  const common = await git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return (
    common.ok &&
    isAbsolute(common.stdout) &&
    !lstat(join(common.stdout, 'info', 'grafts')) &&
    independentObjects(join(common.stdout, 'objects'), root)
  );
}

/** Names the first tip the project does not retain; only runs when the batched check failed. */
async function firstUnretained(project, unique) {
  for (const [oid, ref] of unique) {
    const objects = await project(['rev-list', '--objects', oid, '--not', '--branches', '--tags']);
    if (!objects.ok || objects.stdout !== '') return ref;
  }
  return [...unique.values()][0];
}

/** A tag the wish made or moved is its work by name too: the project must hold it as it is. */
async function unpublishedTag(project, tips, borrowed) {
  const own = tips.filter(([oid, ref]) => ref.startsWith('refs/tags/') && borrowed.get(ref) !== oid);
  if (own.length === 0) return null;
  const listed = await project(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags']);
  if (!listed.ok) return 'unreadable';
  const theirs = new Map(
    listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')),
  );
  const missing = own.find(([oid, ref]) => theirs.get(ref) !== oid);
  return missing === undefined ? null : `unpublished:${missing[1]}`;
}

async function retained({ git, project, root, copy, gitDir }) {
  const refs = await git(['for-each-ref', '--format=%(objectname) %(refname)']);
  const head = await git(['rev-parse', '--verify', 'HEAD']);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!refs.ok || refs.stderr || !head.ok || !branch.ok || !oidPattern.test(head.stdout)) return { keep: 'unreadable' };
  const stashed = lstat(join(gitDir, 'logs', 'refs', 'stash'));
  const tips = [];
  const borrowed = new Map();
  for (const line of refs.stdout.split('\n').filter(Boolean)) {
    const [oid, ref] = line.split(' ');
    if (!oidPattern.test(oid) || !ref?.startsWith('refs/')) return { keep: 'unreadable' };
    if (ref === 'refs/stash') return { keep: 'stash' };
    if (ref.startsWith(BORROWED_TAGS)) borrowed.set(`refs/tags/${ref.slice(BORROWED_TAGS.length)}`, oid);
    else if (!ref.startsWith('refs/remotes/')) tips.push([oid, ref]);
  }
  if (stashed && stashed.size > 0) return { keep: 'stash' };
  tips.push([head.stdout, 'HEAD']);
  const base = copy.baseSha ?? copy.base;
  const unique = new Map();
  for (const [oid, ref] of tips) {
    if (oid === base && (ref === 'HEAD' || ref === `refs/heads/${copy.branch}`)) continue;
    // A tag the copy borrowed at its grant, still where it was, is not the wish's work: the
    // project may have deleted it since, which is the project's call.
    if (borrowed.get(ref) === oid) continue;
    if (!unique.has(oid)) unique.set(oid, ref);
  }
  const ownTag = await unpublishedTag(project, tips, borrowed);
  if (ownTag !== null) return { keep: ownTag };
  if (unique.size > 0) {
    if (!(await verifiableProject(project, root))) return { keep: 'unverifiable' };
    for (const [oid, ref] of unique) {
      if (!(await project(['cat-file', '-e', oid])).ok) return { keep: `unpublished:${ref}` };
    }
    const oids = [...unique.keys()];
    const objects = await project(['rev-list', '--objects', ...oids, '--not', '--branches', '--tags']);
    if (!objects.ok || objects.stdout !== '') return { keep: `unpublished:${await firstUnretained(project, unique)}` };
    // Branch reachability prunes the walk at a retained tip, so read every object the wish
    // added since its base in the project itself: a missing one fails the walk.
    if (typeof base !== 'string' || !(await project(['cat-file', '-e', base])).ok) return { keep: 'unverifiable' };
    const added = await project(['rev-list', '--objects', ...oids, '--not', base]);
    if (!added.ok) return { keep: 'unverifiable' };
  }
  return { sha: head.stdout, branch: branch.stdout };
}

export async function copyVerdict({ copy, root, home, now, git, activity }) {
  const { folder, repo } = copy;
  try {
    const checked = identity(folder, root, repo, home);
    if (checked.keep) return checked;
    if (typeof repo !== 'string' || !lstat(repo)?.isDirectory()) return { keep: 'no-project' };
    // A project's own working tree can never be a deletion candidate.
    if (within(folder, realpathSync(repo))) return { keep: 'no-project' };
    const config = await copyConfig(git, checked.gitDir, realpathSync(repo));
    if (config) return { keep: config };
    const inspect = (args) => git(args, undefined, folder);
    const dirs = await inspect(['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
    if (!dirs.ok || dirs.stdout !== `${checked.gitDir}\n${checked.gitDir}`) return { keep: 'unsupported:worktrees' };
    const live = await activity(copy, now);
    if (live.keep && live.keep !== 'recent') return live;
    const tree = inspectTree(folder, checked.gitDir);
    if (tree.keep) return tree;
    const deadline = Math.max(live.deadline ?? 0, tree.newest + IDLE_MS);
    if (now < deadline) return { keep: 'recent', deadline };
    const status = await clean(inspect);
    if (status) return { keep: status };
    const project = (args) => git(args, repo);
    const work = await retained({ git: inspect, project, root, copy, gitDir: checked.gitDir });
    return { ...checked, ...work, bytes: tree.bytes };
  } catch {
    return { keep: 'unreadable' };
  }
}

export function stillSameCopy(folder, { stat, gitDir, gitStat }) {
  return realpathSync(folder) === folder && sameInode(stat, lstat(folder)) && sameInode(gitStat, lstat(gitDir));
}
