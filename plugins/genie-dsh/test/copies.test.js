import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { NO_PUSH_URL } from '../src/host/git.js';
import { gitIn } from './team.js';
import { commit, end, host, localRepo, scratch, wish } from './wish-fixture.js';

let dir;
beforeEach(() => {
  dir = scratch('genie-dsh-copies-');
});
afterEach(() => {
  mock.restoreAll();
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

const lender = (folder) => dirname(readFileSync(join(folder, '.git/objects/info/alternates'), 'utf8').trim());
async function grantCopy(team, title, branches) {
  const { answer, entry } = await wish(team, title, branches);
  assert.match(answer, /granted as a thread/);
  return entry;
}

function snapshot(dir) {
  return readdirSync(dir, { recursive: true })
    .sort()
    .map((name) => {
      const stat = lstatSync(join(dir, name));
      return [name, stat.size, stat.mtimeMs];
    });
}

function upstream() {
  const seed = localRepo(dir, 'seed');
  const bare = join(dir, 'up.git');
  const repo = join(dir, 'app');
  gitIn(dir, 'clone', '-q', '--bare', seed, bare);
  gitIn(dir, 'clone', '-q', '--single-branch', bare, repo);
  // Keep later fetches of dev only in FETCH_HEAD.
  gitIn(repo, 'config', 'remote.origin.fetch', '+refs/heads/elsewhere:refs/remotes/origin/elsewhere');
  return { seed, bare, repo };
}

function advance({ seed, bare }) {
  const tip = commit(seed, 'fresh upstream', 'upstream.txt');
  gitIn(seed, 'push', '-q', bare, 'dev');
  return tip;
}

test('S1: a grant borrows all initial objects and keeps origin push disabled', async () => {
  const repo = localRepo(dir);
  const team = host(dir, repo);
  const { folder } = await grantCopy(team, 'Borrow');
  const objects = gitIn(folder, 'count-objects', '-v');
  for (const metric of ['count', 'in-pack', 'packs']) assert.match(objects, new RegExp(`^${metric}: 0$`, 'm'));
  const store = lender(folder);
  assert.equal(dirname(store), join(team.team.home, 'genie-objects'));
  assert.match(store, /\/[0-9a-f]{16}\.git$/);
  assert.equal(existsSync(join(store, 'objects/info/alternates')), false);
  assert.equal(gitIn(folder, 'config', 'remote.origin.url'), realpathSync(repo));
  assert.equal(gitIn(folder, 'config', 'remote.origin.pushurl'), NO_PUSH_URL);
  assert.equal(gitIn(folder, 'config', '--local', 'credential.helper'), '');
});

test('S2: repository metadata and new commits stay in the wish', async () => {
  const { folder } = await grantCopy(host(dir, localRepo(dir)), 'Local commits');
  const gitDir = join(folder, '.git');
  assert.ok(lstatSync(gitDir).isDirectory());
  assert.equal(
    gitIn(folder, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'),
    `${gitDir}\n${gitDir}`,
  );
  const store = lender(folder);
  const before = snapshot(store);
  commit(folder, 'wish work');
  assert.match(gitIn(folder, 'count-objects', '-v'), /^count: [1-9]\d*$/m);
  assert.deepEqual(snapshot(store), before);
});

test('S3: pruning and deleting the project leaves the wish usable', async () => {
  const repo = localRepo(dir);
  const { folder, baseSha } = await grantCopy(host(dir, repo), 'Survive');
  gitIn(repo, 'switch', '-q', '--orphan', 'replacement');
  commit(repo, 'replacement');
  gitIn(repo, 'branch', '-D', 'dev');
  gitIn(repo, 'reflog', 'expire', '--expire=now', '--all');
  gitIn(repo, 'gc', '--prune=now');
  assert.throws(() => gitIn(repo, 'cat-file', '-e', baseSha));
  rmSync(repo, { recursive: true });
  gitIn(folder, 'fsck', '--connectivity-only');
  assert.equal(gitIn(folder, 'log', '-1', '--format=%H', baseSha), baseSha);
});

test('S4: normal gc in the store retains a base no longer on any store ref', async () => {
  const repo = localRepo(dir);
  const team = host(dir, repo);
  const { folder, baseSha } = await grantCopy(team, 'Old base');
  const store = lender(folder);
  gitIn(repo, 'switch', '-q', '--orphan', 'replacement');
  commit(repo, 'replacement');
  gitIn(repo, 'branch', '-D', 'dev');
  gitIn(repo, 'branch', '-m', 'dev');
  await grantCopy(team, 'New base');
  assert.equal(gitIn(store, 'branch', '--contains', baseSha), '');
  assert.equal(gitIn(store, 'config', 'gc.pruneExpire'), 'never');
  gitIn(store, 'gc');
  gitIn(folder, 'gc', '--auto');
  gitIn(folder, 'fsck', '--connectivity-only');
  assert.equal(gitIn(folder, 'rev-parse', 'HEAD'), baseSha);
});

test('S5: fetch-by-sha lends the missing FETCH_HEAD base and fetch-back retains its objects', async () => {
  const up = upstream();
  const team = host(dir, up.repo);
  const first = await grantCopy(team, 'First');
  const store = lender(first.folder);
  const tip = advance(up);
  assert.throws(() => gitIn(store, 'cat-file', '-e', tip));
  const entry = await grantCopy(team, 'Fresh');
  assert.equal(gitIn(entry.folder, 'rev-parse', 'HEAD'), tip);
  assert.equal(gitIn(up.repo, 'branch', '-a', '--contains', tip), '');
  gitIn(store, 'cat-file', '-e', tip);
  const commitSha = commit(entry.folder, 'wish change', 'wish.txt');
  await end(team, entry, 'local-only');
  rmSync(store, { recursive: true });
  rmSync(entry.folder, { recursive: true });
  assert.equal(gitIn(up.repo, 'rev-parse', entry.branch), commitSha);
  assert.equal(gitIn(up.repo, 'show', `${entry.branch}:upstream.txt`), 'fresh upstream');
  assert.equal(gitIn(up.repo, 'show', `${entry.branch}:wish.txt`), 'wish change');
  gitIn(up.repo, 'fsck', '--connectivity-only');
});

test('S5 refusal: an unadvertised base refused by protocol v0 never starts a task', async () => {
  const up = upstream();
  const team = host(dir, up.repo);
  const first = await grantCopy(team, 'First');
  const store = lender(first.folder);
  advance(up);
  gitIn(up.repo, 'config', 'uploadpack.allowAnySHA1InWant', 'false');
  const env = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
  const prior = env.map((key) => process.env[key]);
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.version', GIT_CONFIG_VALUE_0: '0' });
  try {
    assert.match((await wish(team, 'Refused')).answer, /Server does not allow request for unadvertised object/i);
    assert.equal(team.team.record.tasks.length, 1);
    assert.equal(existsSync(join(dirname(first.folder), 'refused')), false);
    assert.ok(existsSync(store));
  } finally {
    env.forEach((key, i) => {
      if (prior[i] === undefined) delete process.env[key];
      else process.env[key] = prior[i];
    });
  }
});

test('S6: same-basename projects get separate stores and scoped branches still track origin', async () => {
  const up = upstream();
  const other = localRepo(dir, 'other/app');
  gitIn(up.repo, 'branch', 'earlier');
  const scoped = await grantCopy(host(dir, up.repo), 'Repair', ['earlier']);
  const second = await grantCopy(host(dir, other), 'Other');
  assert.notEqual(lender(scoped.folder), lender(second.folder));
  assert.equal(gitIn(scoped.folder, 'rev-parse', 'earlier'), gitIn(scoped.folder, 'rev-parse', 'origin/earlier'));
  assert.equal(gitIn(scoped.folder, 'remote', 'get-url', 'publish'), up.bare);
});

test('refresh prunes a deleted branch and tag, handles a branch prefix change and lends new tags', async () => {
  const repo = localRepo(dir);
  const team = host(dir, repo);
  gitIn(repo, 'branch', 'topic');
  gitIn(repo, 'tag', 'v1');
  await grantCopy(team, 'First');
  gitIn(repo, 'branch', '-D', 'topic');
  gitIn(repo, 'branch', 'topic/sub');
  gitIn(repo, 'tag', '-d', 'v1');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-am', 'release', 'v2');
  const { folder } = await grantCopy(team, 'Second');
  assert.equal(gitIn(folder, 'branch', '-r', '--list', 'origin/topic*'), 'origin/topic/sub');
  assert.equal(gitIn(folder, 'tag', '--list'), 'v2');
  gitIn(folder, 'checkout', '-q', 'v2');
  assert.equal(gitIn(folder, 'status', '--porcelain'), '');
});

test('an object store under the system temp directory is refused before startTask', async () => {
  const repo = localRepo(dir);
  mock.restoreAll();
  mock.method(os, 'tmpdir', () => dir);
  const h = host(dir, repo);
  assert.match((await wish(h, 'Masked')).answer, /genie-objects.*(?:temp|masked)/i);
  assert.equal(h.team.record.tasks.length, 0);
});

test('an object store under the wishes root is refused before startTask', async () => {
  const repo = localRepo(dir);
  process.env.GENIE_WISHES_DIR = dir;
  const h = host(dir, repo);
  assert.match((await wish(h, 'Writable')).answer, /genie-objects.*wishes root/i);
  assert.equal(h.team.record.tasks.length, 0);
});

test('store transport does not inherit the project alternate or hardlink its objects', async () => {
  const source = localRepo(dir, 'source');
  const repo = join(dir, 'app');
  gitIn(dir, 'clone', '--shared', '-q', source, repo);
  const { folder } = await grantCopy(host(dir, repo), 'Independent lender');
  const store = lender(folder);
  assert.equal(existsSync(join(store, 'objects/info/alternates')), false);
  rmSync(source, { recursive: true });
  rmSync(repo, { recursive: true });
  gitIn(folder, 'fsck', '--connectivity-only');
});

test('the store and two copies are measured together, with dev local clones as the baseline', async (t) => {
  const repo = localRepo(dir);
  writeFileSync(join(repo, 'history.bin'), randomBytes(2 * 1024 * 1024));
  gitIn(repo, 'add', 'history.bin');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'packed fixture history');
  gitIn(repo, 'gc');
  const h = host(dir, repo);
  const storeRoot = join(h.team.home, 'genie-objects');
  const wishesRoot = process.env.GENIE_WISHES_DIR;
  const originalRoot = join(dir, 'dev-wishes');
  for (const path of [wishesRoot, storeRoot, originalRoot]) mkdirSync(path);
  const kib = (root) =>
    execFileSync('du', ['-sk', repo, root, storeRoot], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .reduce((sum, line) => sum + Number.parseInt(line, 10), 0);

  const original = [kib(originalRoot)];
  for (const title of ['first', 'second']) {
    const folder = join(originalRoot, title);
    gitIn(dir, 'clone', '-q', '--local', '--no-checkout', repo, folder);
    gitIn(folder, 'checkout', '-qb', `wish/${title}`, 'HEAD');
    original.push(kib(originalRoot));
  }
  const borrower = [kib(wishesRoot)];
  for (const title of ['first', 'second']) {
    await grantCopy(h, title);
    borrower.push(kib(wishesRoot));
  }

  const sizes = ([before, first, second]) => ({
    totalKiB: [before, first, second],
    incrementsKiB: [first - before, second - first],
  });
  t.diagnostic(
    JSON.stringify({
      devLocalClone: sizes(original),
      borrower: sizes(borrower),
      sameFilesystem: lstatSync(repo).dev === lstatSync(originalRoot).dev,
    }),
  );
  assert.ok(borrower[2] - borrower[1] < borrower[1] - borrower[0]);
});

test('confined DSH commands read the store and write only in the wish folder', async (t) => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local');
  const repo = localRepo(dir);
  const { folder } = await grantCopy(host(dir, repo), 'Confined');
  const store = lender(folder);
  const before = snapshot(store);
  const sandbox = new LocalSandboxProvider(new Context(), {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 5000,
  });
  const policy = { mode: 'workspace-write', workspaceRoot: folder };
  const wrap = (args) => sandbox.confine(args, policy);
  let log;
  try {
    log = await wrap(['git', 'log', '-1', '--format=%s']);
  } catch (error) {
    if (error.code !== 'SANDBOX_UNAVAILABLE') throw error;
    t.skip(`no usable local sandbox backend: ${error.message}`);
    return;
  }
  const run = ({ argv: [program, ...args] }) => execFileSync(program, args, { cwd: folder, encoding: 'utf8' }).trim();
  assert.equal(run(log), 'base');
  assert.equal(run(await wrap(['git', 'status', '--porcelain'])), '');
  run(await wrap(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'confined']));
  assert.equal(gitIn(folder, 'log', '-1', '--format=%s'), 'confined');
  const probe = await wrap(['touch', join(store, 'write-probe')]);
  assert.throws(
    () => run(probe),
    (error) =>
      probe.denialSignatures.some((signature) => String(error.stderr).toLowerCase().includes(signature.toLowerCase())),
  );
  assert.deepEqual(snapshot(store), before);
});
