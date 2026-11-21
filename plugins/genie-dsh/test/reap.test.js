import assert from 'node:assert/strict';
import fs, {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { gitIn, savedWishes } from './team.js';
import { commit, end, host, localRepo, scratch, wish } from './wish-fixture.js';

const IDLE = 30 * 60_000;
let dir;
let repo;
let hosts;
beforeEach(() => {
  dir = scratch('genie-dsh-reap-');
  repo = localRepo(dir);
  hosts = [];
});
afterEach(async () => {
  for (const h of hosts) h.dispose?.();
  for (const h of hosts) await h.rt.genieReconciled;
  mock.restoreAll();
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  rmSync(dir, { recursive: true, force: true });
});

function open(home, options, context) {
  const h = host(home ?? dir, repo, options, context);
  hosts.push(h);
  return h;
}

const root = () => process.env.GENIE_WISHES_DIR;
const history = (h) => join(h.team.home, 'genie.json');
const keptFile = (h) => join(h.team.home, 'genie-copies-kept.json');
const journalFile = (h) => join(h.team.home, 'genie-copies-removed.jsonl');
const journal = (h) =>
  existsSync(journalFile(h)) ? readFileSync(journalFile(h), 'utf8').trim().split('\n').map(JSON.parse) : [];
const kept = (h) => JSON.parse(readFileSync(keptFile(h), 'utf8')).kept;
const reasons = (h, folder) => kept(h).find((item) => item.folder === folder)?.reasons;
const save = (h, records) => writeFileSync(history(h), JSON.stringify({ genieCreated: true, wishes: records }));
async function sweep(h, now = Date.now() + IDLE + 1000) {
  // Drain any settlement- or startup-triggered pass before setting the test clock.
  await h.rt.genieSweep?.();
  return h.rt.genieSweep?.({ now });
}

function age(folder) {
  const past = new Date(Date.now() - IDLE - 1000);
  for (const path of [folder, ...readdirSync(folder, { recursive: true }).map((name) => join(folder, name))]) {
    utimesSync(path, past, past);
  }
}

async function granted(h, title = 'Cleanup') {
  const { answer, entry } = await wish(h, title);
  assert.match(answer, /granted as a thread/);
  return entry;
}

async function ended(h = open()) {
  const entry = await granted(h);
  await end(h, entry);
  return { h, entry, folder: entry.folder };
}

function legacy(slug, project = 'app') {
  const folder = join(root(), project, slug);
  mkdirSync(dirname(folder), { recursive: true });
  gitIn(dir, 'clone', '-q', '--local', repo, folder);
  gitIn(folder, 'checkout', '-qb', `wish/${slug}`);
  gitIn(folder, 'config', 'remote.origin.pushurl', '/dev/null/genie-wish-copies-push-nowhere');
  return folder;
}

function fakeCopy(slug, overrides = {}) {
  const folder = join(root(), 'app', slug);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.git'), 'interrupted checkout\n');
  return { repo, folder, slug, branch: `wish/${slug}`, sessionId: slug, state: 'working', ...overrides };
}

test('R1: an ended production copy with fetched-back work is removed, with intent and outcome', async () => {
  const h = open();
  const entry = await granted(h);
  const sha = commit(entry.folder, 'work');
  await end(h, entry, 'local-only');
  const sibling = legacy('sibling');
  await sweep(h);
  assert.equal(existsSync(entry.folder), false, 'ended fetched-back copy should be removed');
  const [intent, outcome] = journal(h);
  assert.deepEqual([intent.state, outcome.state, intent.id === outcome.id], ['removing', 'removed', true]);
  assert.equal(intent.slug, entry.slug);
  assert.equal(intent.sha, sha);
  assert.equal(intent.branch, entry.branch);
  assert.ok(intent.bytes > 0);
  assert.match(intent.reason, /local-only/);
  assert.ok(existsSync(sibling));
  assert.equal(readdirSync(join(h.team.home, 'genie-objects')).length, 1);
  assert.equal(gitIn(repo, 'rev-parse', entry.branch), sha);
});

for (const [label, path] of [
  ['tracked', 'f.txt'],
  ['nested untracked', 'nested/new'],
]) {
  test(`R2: a ${label} change keeps the copy dirty`, async () => {
    const { h, folder } = await ended();
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), 'change');
    await sweep(h);
    assert.deepEqual(reasons(h, folder), ['dirty']);
    assert.ok(existsSync(folder));
  });
}

for (const kind of ['branch', 'stash', 'detached HEAD', 'tag', 'failed fetch-back', 'remote-tracking ref']) {
  test(`R3: retention accounts for ${kind}`, async () => {
    const h = open();
    const entry = await granted(h);
    const { folder } = entry;
    let expected;
    if (kind === 'stash') {
      writeFileSync(join(folder, 'f.txt'), 'stash me');
      gitIn(folder, 'stash', 'push', '-q');
      expected = 'stash';
    } else if (kind === 'failed fetch-back') {
      commit(folder, 'wish changes');
      commit(repo, 'different project head');
      gitIn(repo, 'branch', entry.branch);
      expected = `unpublished:refs/heads/${entry.branch}`;
    } else {
      gitIn(folder, 'checkout', '-q', '--detach');
      const sha = commit(folder, 'side work');
      if (kind === 'detached HEAD') expected = 'unpublished:HEAD';
      else {
        if (kind === 'branch') gitIn(folder, 'branch', 'side', sha);
        if (kind === 'tag') gitIn(folder, 'tag', '-am', 'release object', 'side', sha);
        if (kind === 'remote-tracking ref') gitIn(folder, 'update-ref', 'refs/remotes/origin/side', sha);
        gitIn(folder, 'checkout', '-q', entry.branch);
        if (kind === 'branch') expected = 'unpublished:refs/heads/side';
        if (kind === 'tag') expected = 'unpublished:refs/tags/side';
      }
    }
    await end(h, entry, kind === 'failed fetch-back' ? 'local-only' : 'no-change');
    await sweep(h);
    if (expected) assert.deepEqual(reasons(h, folder), [expected]);
    assert.equal(existsSync(folder), expected !== undefined);
  });
}

test('R3b: the exact unchanged FETCH_HEAD base needs no project branch', async () => {
  const up = localRepo(dir, 'upstream');
  commit(up, 'fresh base');
  gitIn(repo, 'remote', 'add', 'origin', up);
  gitIn(repo, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
  const { h, entry, folder } = await ended();
  assert.equal(gitIn(repo, 'rev-parse', 'FETCH_HEAD'), entry.baseSha);
  assert.equal(gitIn(repo, 'branch', '-a', '--contains', entry.baseSha), '');
  await sweep(h);
  assert.equal(existsSync(folder), false);
});

for (const path of ['index.lock', 'refs/heads/x.lock', 'objects/info/x.lock']) {
  test(`R4: .git/${path} is a lock`, async () => {
    const { h, folder } = await ended();
    writeFileSync(join(folder, '.git', path), '');
    await sweep(h);
    assert.deepEqual(reasons(h, folder), [`locked:${path}`]);
  });
}

test('R5: the full idle walk includes ignored output and cleans up once it ages', async () => {
  const { h, entry, folder } = await ended();
  mkdirSync(join(folder, '.git/info'), { recursive: true });
  appendFileSync(join(folder, '.git/info/exclude'), '\nignored\n');
  const output = join(folder, 'ignored');
  writeFileSync(output, 'output');
  const now = Date.now() + 2 * IDLE;
  utimesSync(output, new Date(now - 1000), new Date(now - 1000));
  await sweep(h, now);
  assert.deepEqual(reasons(h, folder), ['recent']);
  utimesSync(output, new Date(0), new Date(0));
  await sweep(h, now);
  assert.equal(existsSync(entry.folder), false);
});

for (const state of ['working', 'lost', 'v1', 'no session']) {
  test(`R6: ${state} is busy even with an idle copy`, async () => {
    const folder = legacy('unfinished');
    const h = open();
    save(h, [
      {
        v: state === 'v1' ? 1 : 2,
        folder,
        repo,
        slug: 'unfinished',
        branch: 'wish/unfinished',
        baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
        sessionId: state === 'no session' ? undefined : 'unfinished',
        state: state === 'v1' ? undefined : state === 'no session' ? 'no-change' : state,
      },
    ]);
    await sweep(h);
    assert.deepEqual(reasons(h, folder), ['working']);
  });
}

test('R7: fsmonitor config is refused before repository-aware git', async () => {
  const { h, folder } = await ended();
  const marker = join(dir, 'fsmonitor-marker');
  const hook = join(dir, 'monitor');
  writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 });
  gitIn(folder, 'config', 'core.fsmonitor', hook);
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['config:core.fsmonitor']);
  assert.equal(existsSync(marker), false);
});

test('R7b: a global clean filter is never invoked, and a local filter config keeps the copy', async () => {
  writeFileSync(join(repo, '.gitattributes'), 'f.txt filter=x\n');
  gitIn(repo, 'add', '.gitattributes');
  gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'attributes');
  const { h, folder } = await ended();
  const marker = join(dir, 'filter-marker');
  const cfg = join(dir, 'global.conf');
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    gitIn(repo, 'config', '--global', 'filter.x.clean', `touch "${marker}"; cat`);
    gitIn(folder, 'config', 'filter.x.clean', 'cat');
    await sweep(h);
    assert.deepEqual(reasons(h, folder), ['config:filter.x.clean']);
    gitIn(folder, 'config', '--unset', 'filter.x.clean');
    await sweep(h);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(marker), false);
  } finally {
    if (prior === undefined) Reflect.deleteProperty(process.env, 'GIT_CONFIG_GLOBAL');
    else process.env.GIT_CONFIG_GLOBAL = prior;
  }
});

test('R8: linked, partial and unrelated folders are retained and the store is outside the scan', async () => {
  const { h, folder } = await ended();
  const link = join(dirname(folder), 'link');
  symlinkSync(repo, link);
  const partial = join(dirname(folder), 'partial');
  mkdirSync(partial);
  writeFileSync(join(partial, '.git'), `gitdir: ${join(repo, '.git')}\n`);
  const plain = join(dirname(folder), 'plain');
  mkdirSync(plain);
  const otherClone = join(dirname(folder), 'ordinary');
  gitIn(dir, 'clone', '-q', repo, otherClone);
  const store = dirname(readFileSync(join(folder, '.git/objects/info/alternates'), 'utf8').trim());
  await sweep(h);
  for (const path of [link, partial, plain, otherClone]) assert.deepEqual(reasons(h, path), ['not-a-copy']);
  assert.equal(reasons(h, store), undefined);
  assert.ok(existsSync(repo));
});

test('R9 orphan: startup keeps a legacy wish with no record as no-record', async () => {
  const folder = legacy('orphan');
  const h = open();
  await h.rt.genieReconciled;
  assert.ok(existsSync(folder));
  assert.ok(existsSync(keptFile(h)), 'a retained legacy copy should appear in the kept report');
  assert.deepEqual(reasons(h, folder), ['no-record']);
});

test('R9: another home using the default root cannot reap a quiet wish from the override home', async () => {
  const second = join(dir, 'other-home');
  process.env.GENIE_WISHES_DIR = join(second, 'team', 'wishes');
  const { h, folder } = await ended();
  h.dispose();
  Reflect.deleteProperty(process.env, 'GENIE_WISHES_DIR');
  const stranger = open(second);
  await sweep(stranger);
  assert.deepEqual(reasons(stranger, folder), ['no-record']);
  assert.ok(existsSync(folder));
});

test('R10: eight dirty copies refuse a ninth before creating a folder or task', async () => {
  const seed = open();
  seed.dispose();
  const entries = Array.from({ length: 8 }, (_, i) => {
    const slug = `dirty-${i}`;
    const folder = legacy(slug);
    writeFileSync(join(folder, 'f.txt'), 'dirty');
    age(folder);
    return {
      slug,
      folder,
      repo,
      branch: `wish/${slug}`,
      baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
      sessionId: slug,
      state: 'no-change',
    };
  });
  save(seed, entries);
  const h = open();
  await sweep(h);
  const { answer } = await wish(h, 'Ninth');
  assert.match(answer, /at most 8 wish copies and 8 are on disk/);
  assert.match(answer, /dirty-.*\(dirty\)/);
  assert.ok(answer.includes(keptFile(h)));
  assert.equal(h.team.record.tasks.length, 0);
  assert.equal(existsSync(join(root(), 'app', 'ninth')), false);
});

test('R10: the pre-grant sweep makes room when an eighth recorded copy is eligible', async () => {
  const seed = open();
  seed.dispose();
  const folder = legacy('eligible');
  age(folder);
  save(seed, [
    ...Array.from({ length: 7 }, (_, i) => fakeCopy(`partial-${i}`)),
    {
      folder,
      repo,
      slug: 'eligible',
      branch: 'wish/eligible',
      baseSha: gitIn(repo, 'rev-parse', 'HEAD'),
      sessionId: 'eligible',
      state: 'no-change',
    },
  ]);
  const h = open();
  await granted(h, 'New admission');
  assert.equal(existsSync(folder), false);
  assert.equal(h.team.record.tasks.length, 1);
});

test('admission serializes same-title grants and counts a visible claim only once', async () => {
  const seed = open();
  seed.dispose();
  // An ordinary clone, unrelated directories, and a damaged recorded copy intentionally
  // coexist. Only the six records and the two grants may consume the eight slots.
  save(
    seed,
    Array.from({ length: 6 }, (_, i) => fakeCopy(`partial-${i}`)),
  );
  const unrelated = join(root(), 'app', 'unrelated');
  gitIn(dir, 'clone', '-q', repo, unrelated);
  mkdirSync(join(root(), 'app', 'junk'));
  const h = open();
  const [one, two] = await Promise.all([wish(h, 'Same title'), wish(h, 'Same title')]);
  assert.match(one.answer, /wish\/same-title\./);
  assert.match(two.answer, /wish\/same-title-2\./);
  assert.equal(h.team.record.tasks.length, 2);
  assert.ok(h.team.record.tasks.every((task) => existsSync(task.cwd)));
  assert.match((await wish(h, 'Too many')).answer, /8 are on disk/);
});

test('two grants racing for the eighth slot yield one refusal', async () => {
  const seed = open();
  seed.dispose();
  save(
    seed,
    Array.from({ length: 7 }, (_, i) => fakeCopy(`partial-${i}`)),
  );
  const h = open();
  const results = await Promise.all([wish(h, 'One'), wish(h, 'Two')]);
  assert.equal(results.filter(({ answer }) => answer.includes('granted as a thread')).length, 1);
  assert.equal(results.filter(({ answer }) => answer.includes('8 are on disk')).length, 1);
});

test('R11: startup removes an old eligible copy, but a read-only host leaves it', async () => {
  const { h, folder } = await ended();
  h.dispose();
  age(folder);
  const readonly = open(dir, { readOnly: 'already open', tasks: {}, resumesDone: Promise.resolve({}) });
  await readonly.rt.genieReconciled;
  assert.ok(existsSync(folder));
  assert.equal(journal(readonly).length, 0);
  const normal = open(dir, { tasks: {}, resumesDone: Promise.resolve({}) });
  await normal.rt.genieReconciled;
  assert.equal(existsSync(folder), false);
});

test('R12/R13: kept is current and a second sweep writes no removal records', async () => {
  const { h, folder } = await ended();
  writeFileSync(join(folder, 'new'), 'dirty');
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['dirty']);
  rmSync(join(folder, 'new'));
  await sweep(h);
  assert.equal(reasons(h, folder), undefined);
  const removal = journal(h);
  assert.equal(removal.length, 2);
  await sweep(h);
  assert.deepEqual(journal(h), removal);
});

test('history retains records for existing folders while projecting only 30 wishes', async () => {
  const seed = open();
  seed.dispose();
  const live = fakeCopy('older-live');
  save(seed, [...Array.from({ length: 35 }, (_, i) => ({ slug: `gone-${i}`, at: i })), live]);
  const h = open();
  await granted(h, 'New');
  const records = savedWishes(h.team);
  assert.equal(records.length, 32);
  assert.ok(records.some(({ slug }) => slug === live.slug));
  assert.equal(h.team.record.views[0]().genie.wishes.length, 30);
});

test('unreadable wish history fails closed even after a successful cached load', async () => {
  const { h, folder } = await ended();
  writeFileSync(history(h), 'broken JSON');
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['history-unreadable']);
  assert.ok(existsSync(folder));
});

test('a quiet turn in an ended session and recent approval events protect the copy', async () => {
  const { h, entry, folder } = await ended();
  h.event(entry.sessionId, 'turn/start');
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['working']);
  h.turnEnd(entry.sessionId);
  h.event(entry.sessionId, 'approval/asked', { id: 'ask' });
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['working']);
  h.event(entry.sessionId, 'approval/decided', { id: 'ask' });
  await sweep(h, Date.now() + IDLE / 2);
  assert.deepEqual(reasons(h, folder), ['recent']);
});

test('a pre-reload turn waiting on approval keeps its quiet copy after minute 31', async () => {
  const { h, folder } = await ended();
  h.dispose();
  const reloaded = open(
    dir,
    {},
    {
      agents: () => [{ id: 'another-session', status: 'running', session: { meta: { cwd: folder } } }],
    },
  );
  await sweep(reloaded);
  assert.deepEqual(reasons(reloaded, folder), ['working']);
});

test('a running session whose working folder is inside the copy keeps it', async () => {
  const { h, folder } = await ended();
  h.dispose();
  const inside = join(folder, 'nested');
  mkdirSync(inside);
  age(folder);
  const reloaded = open(
    dir,
    {},
    { agents: () => [{ id: 'another-session', status: 'running', session: { meta: { cwd: inside } } }] },
  );
  await sweep(reloaded);
  assert.deepEqual(reasons(reloaded, folder), ['working']);
});

test('a project tag deleted after the grant does not pin the copy', async () => {
  gitIn(repo, 'checkout', '-qb', 'side');
  commit(repo, 'side only', 'side.txt');
  gitIn(repo, 'tag', 'v-side');
  gitIn(repo, 'checkout', '-q', 'dev');
  gitIn(repo, 'branch', '-D', 'side');
  const { h, folder } = await ended();
  assert.equal(gitIn(folder, 'tag', '--list', 'v-side'), 'v-side');
  gitIn(repo, 'tag', '-d', 'v-side');
  await sweep(h);
  assert.equal(existsSync(folder), false);
});

test('a tag the wish made on an existing commit, or a borrowed tag it moved, keeps the copy', async () => {
  gitIn(repo, 'tag', 'v-old');
  const { h, folder } = await ended();
  const base = gitIn(folder, 'rev-parse', 'HEAD');
  gitIn(folder, 'tag', 'v-new', base);
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['unpublished:refs/tags/v-new']);
  gitIn(folder, 'tag', '-d', 'v-new');
  commit(repo, 'project moves on', 'later.txt');
  gitIn(repo, 'branch', 'keep-later');
  gitIn(folder, 'fetch', '-q', repo, 'keep-later');
  gitIn(folder, 'tag', '-f', 'v-old', 'FETCH_HEAD');
  gitIn(repo, 'branch', '-D', 'keep-later');
  gitIn(repo, 'reset', '-q', '--hard', 'HEAD~1');
  await sweep(h);
  assert.deepEqual(reasons(h, folder), ['unpublished:refs/tags/v-old']);
});

test('missing or failed live agent registry keeps activity unknown', async () => {
  const { h, folder } = await ended();
  h.dispose();
  for (const agents of [
    null,
    () => {
      throw new Error('registry unavailable');
    },
  ]) {
    const reloaded = open(dir, {}, { agents });
    await sweep(reloaded);
    assert.deepEqual(reasons(reloaded, folder), ['activity-unknown']);
  }
});

test('a turn admitted between inspection and removal is caught by the final live check', async () => {
  let checks = 0;
  const admitted = [];
  const h = open(
    dir,
    {},
    {
      agents: () => {
        checks += 1;
        return checks >= 3 ? admitted : [];
      },
    },
  );
  const entry = await granted(h);
  await end(h, entry);
  await h.rt.genieSweep?.();
  admitted.push({ id: entry.sessionId, status: 'running' });
  checks = 0;
  await h.rt.genieSweep({ now: Date.now() + IDLE + 1000 });
  assert.deepEqual(reasons(h, entry.folder), ['working']);
  assert.equal(checks, 3);
  assert.ok(existsSync(entry.folder));
});

test('settlement and sweep serialize when a lost wish gets a later live end', async () => {
  const h = open();
  const entry = await granted(h);
  commit(entry.folder, 'work');
  h.dispose();
  const reloaded = open(dir, { tasks: {}, resumesDone: Promise.resolve({}) });
  await reloaded.rt.genieReconciled;
  assert.equal(savedWishes(reloaded.team)[0].state, 'lost');
  reloaded.turnEnd(entry.sessionId);
  await sweep(reloaded, Date.now() + IDLE / 2);
  assert.ok(existsSync(entry.folder));
  assert.equal(savedWishes(reloaded.team)[0].state, 'local-only');
});

test('linked worktrees, assume-unchanged and skip-worktree keep copies', async () => {
  for (const [i, flag] of ['worktrees', 'assume-unchanged', 'skip-worktree'].entries()) {
    const h = open(join(dir, `host-${i}`));
    const entry = await granted(h, flag);
    await end(h, entry);
    if (flag === 'worktrees') gitIn(entry.folder, 'worktree', 'add', '-qb', 'linked', join(dir, 'linked'));
    else gitIn(entry.folder, 'update-index', `--${flag}`, 'f.txt');
    await sweep(h);
    assert.deepEqual(reasons(h, entry.folder), [
      flag === 'worktrees' ? 'unsupported:worktrees' : 'unsupported:index-flags',
    ]);
  }
});

for (const name of ['rebase-apply', 'MERGE_HEAD', 'sequencer']) {
  test(`an operation stopped half way (${name}) keeps the copy`, async () => {
    const { h, folder } = await ended();
    const path = join(folder, '.git', name);
    if (name === 'MERGE_HEAD') writeFileSync(path, `${gitIn(folder, 'rev-parse', 'HEAD')}\n`);
    else mkdirSync(path);
    age(folder);
    await sweep(h);
    assert.deepEqual(reasons(h, folder), ['unsupported:in-progress']);
  });
}

test('foreign folder ownership is kept before Git inspection', async () => {
  const { h, folder } = await ended();
  const original = process.getuid;
  if (!original) return;
  const stub = mock.method(process, 'getuid', () => original() + 1);
  try {
    await sweep(h);
    assert.deepEqual(reasons(h, folder), ['unsupported:owner']);
  } finally {
    stub.mock.restore();
  }
});

test('a remote-tracking ref in the project is insufficient retention', async () => {
  const { h, entry, folder } = await ended();
  const sha = commit(folder, 'more work');
  gitIn(repo, 'fetch', '-q', folder, `${entry.branch}:refs/remotes/origin/wish`);
  assert.equal(gitIn(repo, 'rev-list', '--objects', sha, '--not', '--remotes'), '');
  await sweep(h);
  assert.deepEqual(reasons(h, folder), [`unpublished:refs/heads/${entry.branch}`]);
});

test('gate 5: a retained project branch and commit with a missing blob do not authorize removal', async () => {
  const h = open();
  const entry = await granted(h);
  commit(entry.folder, 'blob available only in copy');
  await end(h, entry, 'local-only');
  const blob = gitIn(repo, 'rev-parse', `${entry.branch}:f.txt`);
  rmSync(join(repo, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  assert.equal(gitIn(repo, 'rev-list', '--objects', entry.branch, '--not', '--branches', '--tags'), '');
  await sweep(h);
  assert.deepEqual(reasons(h, entry.folder), ['unverifiable']);
  assert.ok(existsSync(entry.folder));
});

for (const type of ['shallow', 'promisor', 'alternate']) {
  test(`gate 5: ${type} project retention is unverifiable`, async () => {
    const h = open();
    const entry = await granted(h);
    const head = commit(entry.folder, 'finished work');
    await end(h, entry, 'local-only');
    if (type === 'shallow') writeFileSync(join(repo, '.git/shallow'), `${head}\n`);
    if (type === 'promisor') gitIn(repo, 'config', 'remote.up.promisor', 'true');
    if (type === 'alternate') {
      writeFileSync(join(repo, '.git/objects/info/alternates'), `${join(entry.folder, '.git/objects')}\n`);
    }
    await sweep(h);
    assert.deepEqual(reasons(h, entry.folder), ['unverifiable']);
  });
}

function intent(folder, id) {
  const { dev, ino } = lstatSync(folder);
  return { folder, id, state: 'removing', at: Date.now(), dev, ino };
}

test('startup reconciles interrupted intents, never retries surviving paths or unrelated reaping names', async () => {
  const { h, entry, folder } = await ended();
  h.dispose();
  const absent = legacy('absent');
  const unrelated = legacy('unrelated');
  const renamed = join(dirname(unrelated), '.reaping-unrelated');
  renameSync(unrelated, renamed);
  appendFileSync(journalFile(h), `${[intent(folder, 'one'), intent(absent, 'two')].map(JSON.stringify).join('\n')}\n`);
  rmSync(absent, { recursive: true });
  const reload = open();
  await reload.rt.genieReconciled;
  await sweep(reload);
  assert.deepEqual(
    journal(reload)
      .slice(2)
      .map(({ id, state }) => [id, state]),
    [
      ['one', 'inspection-required'],
      ['two', 'absent-on-recovery'],
    ],
  );
  assert.deepEqual(reasons(reload, folder), ['inspection-required']);
  assert.ok(existsSync(renamed));
  assert.deepEqual(reasons(reload, renamed), ['not-a-copy']);
  reload.dispose();
  const again = open();
  await sweep(again);
  assert.ok(existsSync(folder));
  assert.equal(journal(again).length, 4);
  renameSync(folder, join(dir, 'old-inode'));
  legacy(entry.slug);
  await sweep(again);
  assert.equal(existsSync(folder), false);
});

test('300 past outcomes survive two more removals and a restarted missing-outcome reconciliation', async () => {
  const h = open();
  const a = await granted(h, 'First');
  const b = await granted(h, 'Second');
  await end(h, a);
  await end(h, b);
  const previous = Array.from({ length: 300 }, (_, i) => JSON.stringify({ id: `past-${i}`, state: 'removed' }));
  writeFileSync(journalFile(h), `${previous.join('\n')}\n`);
  await sweep(h);
  assert.equal(journal(h).filter(({ state }) => state === 'removed').length, 302);
  const lines = readFileSync(journalFile(h), 'utf8').trimEnd().split('\n');
  writeFileSync(journalFile(h), `${lines.slice(0, -1).join('\n')}\n`);
  h.dispose();
  const restart = open();
  await restart.rt.genieReconciled;
  assert.equal(journal(restart).at(-1).state, 'absent-on-recovery');
});

test('the coalesced timer removes the last quiet wish at its earliest deadline', async (t) => {
  // Start the mocked clock at the real time: the idle walk compares it with real file mtimes.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const h = open();
  const entry = await granted(h);
  // Past every mtime the grant wrote (the mocked clock stood still during it).
  t.mock.timers.setTime(Date.now() + 60_000);
  h.turnEnd(entry.sessionId);
  // Drain classification and its settlement-triggered sweep without using a fake poll timer.
  await h.rt.genieSweep();
  assert.ok(existsSync(entry.folder));
  t.mock.timers.tick(IDLE - 1);
  assert.ok(existsSync(entry.folder));
  t.mock.timers.tick(1);
  const until = performance.now() + 4000;
  while (existsSync(entry.folder) && performance.now() < until) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(existsSync(entry.folder), false);
  await h.rt.genieSweep();
});

test('disposal during an awaited inspection prevents deletion and a timer retry', async () => {
  let begin;
  let release;
  let pause = false;
  const started = new Promise((resolve) => {
    begin = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = open(
    dir,
    {},
    {
      agents: () => {
        if (!pause) return [];
        begin();
        return pending;
      },
    },
  );
  const entry = await granted(h);
  await end(h, entry);
  await h.rt.genieSweep();
  pause = true;
  const reaping = sweep(h);
  await started;
  h.dispose();
  release([]);
  await reaping;
  assert.ok(existsSync(entry.folder));
  assert.equal(journal(h).length, 0);
});

test('a partial rmSync failure is held across reload even when only ignored output was removed', async (t) => {
  const { h, folder } = await ended();
  mkdirSync(join(folder, '.git/info'), { recursive: true });
  appendFileSync(join(folder, '.git/info/exclude'), '\nignored\n');
  const output = join(folder, 'ignored');
  writeFileSync(output, 'generated');
  const stub = t.mock.method(fs, 'rmSync', (path, options) => {
    if (path !== folder) return rmSync(path, options);
    const before = journal(h);
    assert.equal(before.at(-1).state, 'removing');
    rmSync(output);
    throw new Error('simulated partial removal');
  });
  await sweep(h);
  stub.mock.restore();
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(folder), true);
  assert.deepEqual(reasons(h, folder), ['remove-failed']);
  assert.match(journal(h).at(-1).error, /simulated partial removal/);
  h.dispose();
  const reloaded = open();
  await sweep(reloaded);
  assert.ok(existsSync(folder));
  assert.deepEqual(reasons(reloaded, folder), ['remove-failed']);
});
