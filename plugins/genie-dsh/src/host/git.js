// The git a wish needs, run as argv (never through a shell) with no prompt: is git here,
// is the folder a repository with a commit, and a clone on a new branch for the wish.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { redact } from './binding.js';
import { canonicalPath, within } from './paths.js';

const TIMEOUT_MS = 30_000;
const STORE_TIMEOUT_MS = 10 * 60_000;

/**
 * One git (or other) command; never throws, so callers decide what a failure means. `env`
 * adds to the environment (binding.js hostGitEnv); GIT_TERMINAL_PROMPT=0 always holds.
 */
export function run(
  command,
  args,
  { cwd, env, timeout = TIMEOUT_MS, replaceEnv = false, maxBuffer = 4 * 1024 * 1024 } = {},
) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout,
        env: { ...(replaceEnv ? {} : process.env), ...env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr || error?.message || '').trim(),
        });
      },
    );
  });
}

export const MISSING_TOOLS_MAC =
  'Genie needs git, and this Mac does not have it yet. Open Terminal and run this one line: xcode-select --install — then accept the install, and ask Genie again.';
export const MISSING_GIT =
  'Genie needs git, which is not installed on this computer. Install it (on Ubuntu or Debian: sudo apt install git), then ask Genie again.';

/**
 * Why git cannot run here, or null when it can. On a Mac without the Command Line Tools,
 * /usr/bin/git opens Apple's install dialog instead of failing, so xcode-select is asked
 * first and git is never started there.
 */
export async function gitProblem({ platform = process.platform, exec = run } = {}) {
  if (platform === 'darwin') {
    const tools = await exec('xcode-select', ['-p']);
    if (!tools.ok) return MISSING_TOOLS_MAC;
  }
  const git = await exec('git', ['--version']);
  if (!git.ok) return platform === 'darwin' ? MISSING_TOOLS_MAC : MISSING_GIT;
  // Wish copies use `init --object-format` (2.29) and the cleanup `rev-parse --path-format` (2.31).
  const [, major, minor] = /git version (\d+)\.(\d+)/.exec(git.stdout ?? '') ?? [];
  if (major !== undefined && Number(major) * 1000 + Number(minor) < 2031) {
    return `Genie needs git 2.31 or later, and this computer has ${major}.${minor}. Update git, then ask Genie again.`;
  }
  return null;
}

export const git = (args, cwd) => run('git', args, { cwd });

/**
 * A wish's git: `g(step, args, cwd)` runs one command with `options.env` (read at each call,
 * so the binding can set it once it is known) and, when `options.note` is given, hands it
 * `{ step, argv, code, ms }` with every http(s) URL in argv written without its userinfo.
 */
export function gitRunner(options = {}) {
  return async (step, args, cwd, timeout) => {
    const started = Date.now();
    const result = await run('git', args, { cwd, env: options.env, timeout });
    options.note?.({ step, argv: ['git', ...args].map(redact), code: result.code, ms: Date.now() - started });
    return result;
  };
}
const plainGit = gitRunner();

// A push URL no transport accepts: a wish's origin is the user's own checkout, which no wish
// pushes into, so `git push origin` fails in every wish's copy.
export const NO_PUSH_URL = '/dev/null/genie-wish-copies-push-nowhere';

/** The repository's top folder, or null when `dir` is not inside one. */
export async function topLevel(dir) {
  const result = await git(['rev-parse', '--show-toplevel'], dir);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

export async function currentBranch(dir, g = plainGit) {
  const result = await g('current-branch', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return result.ok ? result.stdout : null;
}

export async function branchExists(dir, branch, g = plainGit) {
  return (await g('branch-exists', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir)).ok;
}

/**
 * A new repository on `dev` with one empty commit, so a wish has something to branch from.
 * With no git identity on the machine, the repository gets Genie's own, locally.
 */
export async function initRepo(dir) {
  const init = await git(['init', '-b', 'dev'], dir);
  if (!init.ok) return { ok: false, error: init.stderr || 'git init failed' };
  const email = await git(['config', 'user.email'], dir);
  if (!email.ok || email.stdout === '') {
    await git(['config', 'user.name', 'Genie'], dir);
    await git(['config', 'user.email', 'genie@localhost'], dir);
  }
  const commit = await git(['commit', '--allow-empty', '-m', 'Genie starts here'], dir);
  if (!commit.ok) return { ok: false, error: commit.stderr || 'the first commit failed' };
  return { ok: true };
}

export function storeFor(home, repo) {
  const key = createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 16);
  return join(canonicalPath(home), 'genie-objects', `${key}.git`);
}

export function storeProblem(store, wishesRoot, folder) {
  const path = canonicalPath(store);
  const tempRoots = ['/tmp', os.tmpdir()].map(canonicalPath);
  if (tempRoots.some((root) => within(root, path))) return `the object store ${path} is in a masked temp directory`;
  if (within(canonicalPath(wishesRoot), path) || within(canonicalPath(folder), path)) {
    return `the object store ${path} is inside the writable wishes root`;
  }
  return null;
}

const headRefs = '+refs/heads/*:refs/heads/*';
const tagRefs = '+refs/tags/*:refs/tags/*';
// The tags a copy borrowed at its grant, so the cleanup can tell them from tags the wish made.
export const BORROWED_TAGS = 'refs/genie-borrowed/tags/';
const fetchFlags = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-auto-gc'];
const gitFailure = (result, fallback) => ({ ok: false, error: redact(result.stderr) || fallback });

async function refreshStore(repo, dir, base, g) {
  const refs = await g('store-refs', [...fetchFlags, '--prune', '--', repo, headRefs, tagRefs], dir, STORE_TIMEOUT_MS);
  if (!refs.ok) return gitFailure(refs, 'git could not refresh the object store');
  if (await commitOf(dir, base, g, 'store-base')) return { ok: true };
  const fetched = await g('store-fetch-base', [...fetchFlags, '--', repo, base], dir, STORE_TIMEOUT_MS);
  if (!fetched.ok) return gitFailure(fetched, 'git could not fetch the base into the object store');
  if (await commitOf(dir, base, g, 'store-base')) return { ok: true };
  return { ok: false, error: `the object store does not have base commit ${base}` };
}

function checkStore(store) {
  if (!lstatSync(store).isDirectory() || realpathSync(store) !== store) {
    return `the object store ${store} is not a standalone directory`;
  }
  try {
    lstatSync(join(store, 'objects', 'info', 'alternates'));
    return `the object store ${store} depends on another repository`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

/** Populate by transport so the store owns its objects even when the project uses alternates. */
export async function ensureStore(repo, store, base, g = plainGit) {
  let temp;
  try {
    try {
      const problem = checkStore(store);
      if (problem !== null) return { ok: false, error: problem };
      return await refreshStore(repo, store, base, g);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const format = await g('store-format', ['rev-parse', '--show-object-format'], repo);
    if (!format.ok) return gitFailure(format, 'git could not read the project object format');
    mkdirSync(dirname(store), { recursive: true });
    temp = mkdtempSync(join(dirname(store), '.initializing-'));
    const init = await g(
      'store-init',
      ['init', '--bare', '--quiet', '--template=', `--object-format=${format.stdout}`],
      temp,
    );
    if (!init.ok) return gitFailure(init, 'git could not initialize the object store');
    for (const [key, value] of [
      ['gc.pruneExpire', 'never'],
      ['gc.auto', '0'],
    ]) {
      const config = await g('store-config', ['config', key, value], temp);
      if (!config.ok) return gitFailure(config, `git could not set ${key} in the object store`);
    }
    const refreshed = await refreshStore(repo, temp, base, g);
    if (!refreshed.ok) return refreshed;
    const problem = checkStore(temp);
    if (problem !== null) return { ok: false, error: problem };
    renameSync(temp, store);
    temp = undefined;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: redact(error.message) };
  } finally {
    if (temp !== undefined) rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * The wish owns its Git directory, index, refs and new objects so DSH can confine writes to
 * the wish folder. It borrows existing objects through an alternate in the team home.
 *
 * Its origin is the project folder, which no wish pushes into, so origin's push URL goes
 * nowhere. A plain wish (`plain`) also gets an empty credential helper: nothing the host
 * does in its copy needs credentials, so the default routes to a push are gone in code, not
 * only in the brief's words. A scoped follow-up keeps the user's helper for its `publish`.
 */
export async function cloneForWish(repo, dir, branch, base, { g = plainGit, plain = true, store } = {}) {
  const format = await g('copy-format', ['rev-parse', '--show-object-format'], store);
  if (!format.ok) return gitFailure(format, 'git could not read the object store format');
  const init = await g('copy-init', ['init', '--quiet', '--template=', `--object-format=${format.stdout}`, dir]);
  if (!init.ok) return gitFailure(init, 'git could not initialize the wish copy');
  writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), `${join(store, 'objects')}\n`, { flag: 'wx' });
  const origin = await g('copy-origin', ['remote', 'add', 'origin', repo], dir);
  if (!origin.ok) return gitFailure(origin, 'git could not set the wish origin');
  const borrowed = `+refs/tags/*:${BORROWED_TAGS}*`;
  const refs = await g(
    'copy-refs',
    [...fetchFlags, '--', store, '+refs/heads/*:refs/remotes/origin/*', tagRefs, borrowed],
    dir,
  );
  if (!refs.ok) return gitFailure(refs, 'git could not load refs from the object store');
  const checkout = await g('checkout', ['checkout', '--quiet', '-b', branch, base], dir);
  if (!checkout.ok) return { ok: false, error: redact(checkout.stderr) || 'git checkout failed' };
  for (const [key, fallback] of [
    ['user.name', 'Genie'],
    ['user.email', 'genie@localhost'],
  ]) {
    // The project's own setting, else the machine's (a clone keeps neither of the project's).
    const own = await g('identity', ['config', key], repo);
    if (own.ok && own.stdout !== '') await g('identity', ['config', key, own.stdout], dir);
    else if (!(await g('identity', ['config', key], dir)).ok) await g('identity', ['config', key, fallback], dir);
  }
  const lockout = [['config', 'remote.origin.pushurl', NO_PUSH_URL]];
  if (plain) lockout.push(['config', 'credential.helper', '']);
  for (const args of lockout) {
    const set = await g('no-push', args, dir);
    if (!set.ok) return { ok: false, error: redact(set.stderr) || `git ${args.join(' ')} failed` };
  }
  return { ok: true };
}

/**
 * Brings a wish's branch from its clone into the project, never overwriting one there that
 * moved elsewhere. `code` is git's exit code, for the wish's evidence.
 */
export async function fetchWishBranch(repo, dir, branch, g = plainGit) {
  const result = await g('fetch-back', ['fetch', '--quiet', dir, `refs/heads/${branch}:refs/heads/${branch}`], repo);
  return result.ok
    ? { ok: true, code: 0 }
    : { ok: false, code: result.code, error: redact(result.stderr) || 'git fetch failed' };
}

/** The commit `ref` is on in `dir`, or null. */
export async function commitOf(dir, ref, g = plainGit, step = 'rev-parse') {
  const result = await g(step, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir);
  return result.ok && result.stdout !== '' ? result.stdout : null;
}

/** How many commits `dir` has on `tip` that `from` lacks, or null when git cannot say. */
export async function aheadOf(dir, from, tip, g = plainGit, step = 'ahead') {
  const result = await g(step, ['rev-list', '--count', `${from}..${tip}`], dir);
  const count = Number.parseInt(result.stdout, 10);
  return result.ok && Number.isFinite(count) ? count : null;
}

/**
 * Gives a wish's copy the named branches the project already has, as local branches it may
 * change. The clone's remote-tracking refs carry the project's branches already.
 */
export async function grantBranches(dir, branches, g = plainGit) {
  for (const branch of branches) {
    const made = await g('give-branch', ['branch', '--quiet', branch, `origin/${branch}`], dir);
    if (!made.ok) return { ok: false, error: redact(made.stderr) || `git branch ${branch} failed` };
  }
  return { ok: true };
}

/** In a wish's copy, the project's real remote as `publish`, so a scoped wish can push there. */
export async function addPublishRemote(dir, url, g = plainGit) {
  const added = await g('publish-remote', ['remote', 'add', 'publish', url], dir);
  return added.ok ? { ok: true } : { ok: false, error: redact(added.stderr) || 'git remote add failed' };
}
