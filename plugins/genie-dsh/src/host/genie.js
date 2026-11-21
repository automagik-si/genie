// The Genie Bots and their wishes. A team may have many Genies, one per repository (its
// Bot's workDir), each in a color no other Genie wears; genie-create adds one for a folder.
// grant_wish makes the wish its own clone of the project, on a new wish/<slug> branch, and
// hands the wish to a Tasks session there (rt.startTask): the team runs it, shows it as a
// thread under Genie while it works, resumes it after a restart, and brings its final
// report back to Genie's chat when it ends. The wish starts from its repository's base as
// the remote has it right now (binding.js), in a copy with no push route. When it ends,
// this module counts what moved, fetches the branches that hold work back into the project,
// and writes down the outcome and the evidence (wishes.js), so ended wishes stay listed
// under Genie with what really happened: a local branch is never called done or delivered.
// A follow-up wish may be scoped to branches an earlier wish made (`branches`), so it can
// repair and publish exactly those and nothing else.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fetchBase, hasHttpUserinfo, remoteDisplay, resolveBinding } from './binding.js';
import { readHistory, writeJson } from './copy-state.js';
import { claimCopy as claimFolder, removeCopy, stillClaimed } from './copy.js';
import {
  addPublishRemote,
  aheadOf,
  branchExists,
  cloneForWish,
  commitOf,
  currentBranch,
  ensureStore,
  fetchWishBranch,
  gitProblem,
  gitRunner,
  grantBranches,
  initRepo,
  storeFor,
  storeProblem,
  topLevel,
} from './git.js';
import { canonicalPath, lstat } from './paths.js';
import { createReaper } from './reap.js';
import { WISH_VERSION, awaitsEnd, endedState, newEvidence, noteCommand, taskOutcome, turnOutcome } from './wishes.js';

export const GENIE_KIND = 'genie';
export const GENIE_NAMES = ['Genie', 'Genie Bot', 'The Genie'];
export const GENIE_PROJECT = 'genie';
export const WISHES_KEPT = 30;
// A tool's text result, drawn as the team's own tools draw theirs (bots-dsh src/host/tools.js).
const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

const GENIE_RULES = [
  'You are Genie: you grant wishes in your project, the folder you live in.',
  'Talk with the user in plain words. When they want something built, changed or fixed in the project, agree on the wish in a sentence or two, then call grant_wish with a short title and the whole wish written so it stands on its own.',
  "Each wish runs as its own thread, in its own copy of the project on a branch wish/<name> made from the project's base as its remote has it now, so your chat stays clean. A plain wish cannot push: it commits in its copy, and nothing is published or merged.",
  'When it ends, its report comes back to you, and its row under you shows the outcome in one of these words: Local branch (it committed, and its branch was brought back into the project), No change (no branch moved), Stopped, Failed or Lost (the team no longer has its record). Tell the user that word and, in a line or two, what was done and where. For a local branch, say "local branch, not published": it is in the project for them to review, and nothing was pushed, merged or opened as a pull request unless a scoped follow-up says it published.',
  'When the user asks a follow-up wish to repair or publish branches an earlier wish made, pass exactly those names as grant_wish branches: that is the only scope in which a wish may push. Never give it the project branch it was made from, and never a branch the user did not name.',
  'If grant_wish answers that something is missing (git, a project folder), give the user exactly the fix it names.',
  'Do not do the wish yourself in this chat.',
];

// What `rt.uiLanguage` may be before it is written into a Genie's saved instructions: a locale
// in the pattern the Bot team accepts from a browser (bots-dsh channel.js, the `state`
// endpoint), at most 35 characters (the tag length BCP 47 asks every implementation to take),
// or a name the team gives a language it knows (channel.js LANGUAGES). Anything else gets the
// rule that names no language.
const LOCALE = /^[a-z]{2,3}(-[\w-]+)?$/i;
const LOCALE_MAX = 35;
const LANGUAGE_NAMES = new Set(['English', 'Chinese (简体中文)']);
const interfaceLanguage = (value) => {
  if (typeof value !== 'string') return undefined;
  const known = value.trim();
  if (LANGUAGE_NAMES.has(known)) return known;
  return known.length <= LOCALE_MAX && LOCALE.test(known) ? known : undefined;
};

const LANGUAGE_RULE = 'Write in the language the user writes in;';

/**
 * Genie's instructions. `language` is the app's interface language when the team knows it
 * (the last browser that asked the team reported its locale, bots-dsh `rt.uiLanguage`), so
 * the first message is in the language the person reads rather than in the language of this
 * text (#3224). Without it the rule still sends Genie to the user's language and to the
 * interface's, because the team may not have heard from a browser yet when a Genie is made.
 */
export function genieInstructions(language) {
  const known = interfaceLanguage(language);
  const rule =
    known === undefined
      ? `${LANGUAGE_RULE} before they write, in the language of this app's interface. These instructions being in English is no reason to answer in English.`
      : `${LANGUAGE_RULE} before they write, in ${known}, the language of this app's interface.`;
  return [...GENIE_RULES, rule].join('\n');
}

// The instructions a Genie takes when the team's interface language is not known yet.
export const GENIE_INSTRUCTIONS = genieInstructions();

// The sha256 of every default text earlier versions gave a Genie, none of which names a
// language (79492685e, 28644a227, 7dfcc6392; the texts are in test/fixtures). A Genie still on
// one of these, or on GENIE_INSTRUCTIONS, has instructions no user wrote.
const EARLIER_DEFAULTS = new Set([
  'b6e67f6ff3ce74978cad02d0ec689317a106b8c71a8c034ebe74d745607f8141',
  '64c97607b3fbfa738565714f959abf9eebdd2e92c284f837b311a1a77ac74075',
  '2b0ec8184e103d1ee3b02e173b4fcd423c17f3f12f0c83351e7a66e4f9201f10',
]);

/** Whether `text` is exactly a default Genie text that names no language. */
export const isDefaultInstructions = (text) =>
  typeof text === 'string' &&
  (text === GENIE_INSTRUCTIONS || EARLIER_DEFAULTS.has(createHash('sha256').update(text).digest('hex')));

// A Genie's colors, one per Genie: the first is the color Genie's own art is painted in
// (magenta, ~325°), so the first Genie and one saved before Genies had colors keep that look.
// Bot team color ids (bots-dsh characters.js).
export const GENIE_COLORS = Object.freeze([
  'magenta',
  'violet',
  'blue',
  'cyan',
  'green',
  'yellow',
  'orange',
  'red',
  'aurora',
  'brown',
  'gray',
  'black',
]);

/** The color a Genie wears. */
export const genieColorOf = (bot) => bot?.color ?? GENIE_COLORS[0];

/** The first Genie color no Genie in `genies` wears, or undefined when every one is taken. */
export function freeGenieColor(genies) {
  const taken = new Set(genies.map(genieColorOf));
  return GENIE_COLORS.find((color) => !taken.has(color));
}

/** A name for a new Genie in `repo`: Genie while that is free, else Genie <repo>, numbered past a clash. */
export function genieNameFor(repo, taken) {
  if (!taken('Genie')) return 'Genie';
  const stem = `Genie ${basename(repo)}`.slice(0, 34).trim();
  if (!taken(stem)) return stem;
  let n = 2;
  while (taken(`${stem} ${n}`)) n += 1;
  return `${stem} ${n}`;
}

export const GENIE_BOT = Object.freeze({
  kind: GENIE_KIND,
  // The team keeps a role to ROLE_MAX (24) characters (bots-dsh roster.js).
  role: 'Grants your wishes',
  instructions: GENIE_INSTRUCTIONS,
});

/** A branch-safe short name for a wish title. */
export function slugOf(title) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'wish' : slug;
}

/** What the wish thread is told: the wish, where to work, what it may touch and how to finish. */
export function wishBrief({ title, wish, folder, branch, base, branches = [], canPublish = false }) {
  // A wish that was given branches may change those too, and push only them when the project
  // has a remote; every other branch keeps the plain wish rule.
  const scope =
    branches.length === 0
      ? ' This copy has no push route, by design: commit here, never merge or touch any other branch, and if the wish asked you to push or open a pull request, say in your final report that you could not.'
      : [
          ` This wish was also given these existing branches: ${branches.join(', ')}. Commit your repairs on them.`,
          canPublish
            ? ' Publish each one with git push publish <branch>, and open or update its pull request; never force-push, merge, or deploy.'
            : ' The project has no git remote, so they cannot be published: commit the repairs and say so in your final report.',
          ' Do not push, merge, or touch any branch not listed here.',
        ].join('');
  return [
    'You are a Genie wish thread. Grant exactly this one wish, then report.',
    '',
    `Wish: ${title}`,
    wish,
    '',
    `Work only in ${folder}: your own copy of the project, on branch ${branch} (made from ${base.slice(0, 12)}). Run every command there and use absolute paths under it.`,
    '1. Read the project first (README, AGENTS.md or CLAUDE.md when present) and plan in a few lines.',
    '2. Make the change.',
    "3. Run the project's own checks or tests when it has them, and fix what fails.",
    `4. Commit everything on ${branch} with a clear message (git add -A, then git commit).${scope}`,
    '5. End with a short final report: what changed (files), how you checked it (commands and their results), and anything left open.',
    'If you need a decision you cannot make, stop and ask it in your final report.',
    'If a step is refused for a permission (an approval, the sandbox or a deny list), say which step and why in your next message, then go on with what you can still do.',
  ].join('\n');
}

// Where the wishes' copies live: in the team workspace, where a Tasks session may write
// (DSH's workspace-write sandbox), whichever folder the project itself is in.
export function wishesRoot(teamFolder, env = process.env) {
  if (env.GENIE_WISHES_DIR) return env.GENIE_WISHES_DIR;
  return typeof teamFolder === 'string' ? join(teamFolder, 'wishes') : join(homedir(), '.genie', 'wishes');
}

export function install(rt) {
  const { ctx } = rt;
  const file = () => join(rt.home, 'genie.json');

  let data;
  const load = () => {
    if (data !== undefined) return data;
    try {
      data = readHistory(file());
    } catch {
      return { genieCreated: false, wishes: [] };
    }
    return data;
  };
  const save = () => {
    // An unreadable file never becomes removal authority or gets overwritten.
    readHistory(file());
    writeJson(file(), data);
  };

  const workspace = () => wishesRoot(rt.teamFolder?.());
  const copyClaims = new Set();
  let copies = Promise.resolve();
  function withCopies(work) {
    const next = copies.then(work);
    copies = next.catch(() => {});
    return next;
  }

  let sweeping;
  function sweep(options) {
    sweeping ??= withCopies(() => reaper.scan(options)).finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  }
  const reaper = createReaper(rt, { workspace, history: file, claims: copyClaims, retry: sweepSoon });

  const genieBots = () => Object.values(rt.state?.bots ?? {}).filter((bot) => bot.kind === GENIE_KIND);

  // The first Genie, made once (the plugin loads on every start): an existing Genie is kept,
  // and one the user deleted is not made again. More come from createGenie.
  async function ensureGenie() {
    await rt.load();
    if (rt.readOnly() !== undefined) return undefined;
    const existing = genieBots()[0];
    if (existing !== undefined) return existing;
    if (load().genieCreated) return undefined;
    // The team's workspace holds Genie's first project, as the welcome's Omni Bot does.
    await rt.ensureWorkspace?.();
    const team = rt.teamFolder?.();
    const project = typeof team === 'string' ? join(team, GENIE_PROJECT) : undefined;
    if (project !== undefined) mkdirSync(project, { recursive: true });
    const name = GENIE_NAMES.find((candidate) => rt.findBot?.(candidate) === undefined) ?? `Genie ${Date.now()}`;
    const bot = await rt.createBot({
      ...GENIE_BOT,
      name,
      color: GENIE_COLORS[0],
      workDir: project,
      // The app's language the team has heard so far, so the first message is not English
      // just because these instructions are (#3224).
      instructions: genieInstructions(rt.uiLanguage?.()),
      pickModel: await noModel(),
    });
    load().genieCreated = true;
    save();
    return bot;
  }

  // With a default model already served (Connect AI done), a new Genie takes it and greets at
  // once; with none, its greeting waits until Connect AI gives it one.
  const noModel = async () => (await Promise.resolve(rt.defaultModel?.()).catch(() => undefined)) === undefined;

  // The repository a Genie lives in, or null when its folder is not in one.
  const repoOf = (bot) => {
    const folder = bot.workDir ?? rt.workDirOf?.({ botId: bot.id });
    return typeof folder === 'string' ? topLevel(folder) : Promise.resolve(null);
  };
  const genieView = (bot) => ({ id: bot.id, name: bot.name, color: genieColorOf(bot) });

  // A Genie for the repository `folder` is in: the one already living there, else a new one in
  // the first free Genie color. One at a time, so two quick presses make one Genie.
  let creating = Promise.resolve();
  function createGenie({ folder } = {}) {
    const run = creating.then(async () => {
      await rt.load();
      const readOnly = rt.readOnly();
      if (readOnly !== undefined) throw new Error(readOnly);
      if (typeof folder !== 'string' || folder.trim() === '')
        throw new Error('Pick the repository this Genie will live in.');
      const repo = await topLevel(folder.trim());
      if (repo === null)
        throw new Error(`${folder.trim()} is not in a git repository. Pick a repository, or run git init there first.`);
      for (const bot of genieBots()) if ((await repoOf(bot)) === repo) return { bot: genieView(bot), existed: true };
      const color = freeGenieColor(genieBots());
      if (color === undefined)
        throw new Error(`Every Genie color is taken (${GENIE_COLORS.length} Genies). Remove a Genie to add another.`);
      const name = genieNameFor(repo, (candidate) => rt.findBot?.(candidate) !== undefined);
      const bot = await rt.createBot({
        ...GENIE_BOT,
        name,
        color,
        workDir: repo,
        instructions: genieInstructions(rt.uiLanguage?.()),
        pickModel: await noModel(),
      });
      load().genieCreated = true;
      save();
      return { bot: genieView(bot), existed: false };
    });
    creating = run.catch(() => {});
    return run;
  }

  const ready = (async () => {
    try {
      await ensureGenie();
    } catch (error) {
      rt.warn?.('genie: the Genie Bot was not made: %s', error?.message ?? error);
    }
  })();

  // #3224: the team learns the interface language only when a browser asks for the team, and
  // keeps it in memory only. So the first Genie, made as the plugin loads, is made without it,
  // and a Genie from an earlier version has a default text that names none. Once the language
  // is known, a Genie whose instructions are still exactly a default text gets the text naming
  // it; instructions anyone changed are never touched, nor a Genie already told a language.
  // Written into the Bot itself, not through the team's update: the team reads a Bot's
  // instructions on every turn (bots-dsh prompt.js), so a held greeting (roster.js `kickoff`)
  // goes out in the language and a Genie that already greeted uses it from its next turn,
  // while the team's update would start a turn of its own to announce the change.
  function nameTheLanguage() {
    if (rt.readOnly() !== undefined) return;
    const language = interfaceLanguage(rt.uiLanguage?.());
    if (language === undefined) return;
    const stale = genieBots().filter((bot) => isDefaultInstructions(bot.instructions));
    if (stale.length === 0) return;
    const instructions = genieInstructions(language);
    for (const bot of stale) bot.instructions = instructions;
    rt.save().catch((error) => rt.warn?.('genie: the interface language was not saved: %s', error?.message ?? error));
  }

  // Genie's own folder starts as a repository; a folder the user picked is never changed.
  async function repositoryFor(bot) {
    const folder = bot.workDir ?? rt.workDirOf?.({ botId: bot.id }) ?? rt.teamFolder?.();
    if (typeof folder !== 'string' || !existsSync(folder)) {
      return { error: "Genie has no project folder. Pick one in Genie's settings (Working folder), then ask again." };
    }
    let top = await topLevel(folder);
    if (top === null) {
      if (reaper.blocked()) return { error: grantUnavailable() };
      const own = basename(folder) === GENIE_PROJECT;
      if (!own) {
        return {
          error: `The folder ${folder} is not a git repository. Run git init there, or pick a git repository as Genie's working folder in its settings.`,
        };
      }
      const made = await initRepo(folder);
      if (!made.ok) return { error: `Genie could not start a repository in ${folder}: ${made.error}` };
      top = await topLevel(folder);
    }
    return { repo: top };
  }

  // The branches a follow-up wish may change besides its own: branches the project already has,
  // never the one the project is on (the integration branch a wish is made from), nor the base
  // wishes start from, nor main/master. Returns the clean scope, or the sentence to answer with.
  async function scopedBranches(repo, branches, base, g) {
    if (branches === undefined) return [];
    if (!Array.isArray(branches) || branches.some((name) => typeof name !== 'string'))
      return 'The wish did not start: branches must be a list of branch names.';
    const integration = await currentBranch(repo, g);
    const scope = [];
    for (const raw of branches) {
      const name = raw.trim();
      if (name === '' || scope.includes(name)) continue;
      if (name === integration || name === 'main' || name === 'master')
        return `The wish did not start: ${name} is the project's integration branch, which a wish never pushes or merges. Name the branches an earlier wish made.`;
      if (name === base)
        return `The wish did not start: ${name} is the branch wishes start from, which a wish never pushes or merges. Name the branches an earlier wish made.`;
      if (!(await branchExists(repo, name, g)))
        return `The wish did not start: ${name} is not a branch in ${repo} to give it.`;
      scope.push(name);
    }
    return scope;
  }

  const grantUnavailable = () => rt.readOnly() ?? 'The wish did not start: Genie is unloading.';

  // After a failed startTask the wish's copy is removed for one failure only: the team's
  // refusal of a start whose permission level did not hold, an error whose own `levelNotSet` is
  // exactly true (not a truthy value, not a flag on its `cause`). The team throws it before the
  // first turn, so nothing ran in the copy. No other throw says that: the turn may have been
  // queued, worked there and ended, and the team may even have forgotten its task since, so
  // every other failed start keeps the copy. The flag is taken on trust, with no check of who
  // set it: a plugin that put it on an error thrown after a turn would cause a removal. None
  // in the Bot team's source does.
  // `left` is filled when a failed grant keeps its copy, for the tool's answer: `why` is `ran`
  // (work may have run there), `failed` (the removal failed) or `uncertain` (the folder at its
  // path could not be shown to be the one this grant made, so the path is not to be trusted).
  function keptNote({ folder, why }) {
    if (folder === undefined) return '';
    if (why === 'uncertain')
      return " A copy of the project made for this wish may remain among Genie's wish copies: it was not removed, because Genie could not confirm which folder is the one it made. Tell the user that, and do not delete any folder on this message alone.";
    const reason = why === 'failed' ? 'it could not be removed' : 'work may have run there';
    return ` Its copy of the project was kept at ${folder}, because ${reason}. Tell the user; delete that folder by hand once nothing is working in it.`;
  }

  function grantWish(input, left = {}) {
    return withCopies(async () => {
      if (reaper.blocked()) return grantUnavailable();
      const census = await reaper.scan();
      if (census.stopped) return grantUnavailable();
      if (census.historyUnreadable) return `The wish did not start: wish history is unreadable. See ${reaper.file}.`;
      const refusal = reaper.refuse(census);
      if (refusal !== null) return refusal;

      const prepared = await prepareWish(input);
      if (prepared.error) return prepared.error;
      return startWish(input, prepared, left);
    });
  }

  async function prepareWish({ bot, branches }) {
    const problem = await gitProblem();
    if (problem !== null) return { error: problem };
    const where = await repositoryFor(bot);
    if (where.error) return where;
    const repo = realpathSync(where.repo);
    // Every git command the host runs for this wish from here on is in its evidence.
    const evidence = newEvidence();
    const gitOptions = { env: {}, note: (command) => noteCommand(evidence, command) };
    const g = gitRunner(gitOptions);
    const bound = await resolveBinding(repo, g);
    if (bound.error !== undefined) return { error: `The wish did not start: ${bound.error}` };
    gitOptions.env = bound.env;
    const { binding } = bound;
    const scope = await scopedBranches(repo, branches, binding.base, g);
    if (typeof scope === 'string') return { error: scope };
    // A scoped follow-up's copy gets the remote's URL as `publish` (#3184): one that carries
    // credentials in it would copy them there, so it is refused instead.
    if (scope.length > 0 && hasHttpUserinfo(bound.url)) {
      const display = remoteDisplay(bound.url);
      return {
        error: `The wish did not start: the URL of the remote ${binding.remote} has a user name or password written into it, and a follow-up that publishes would copy it into its copy. Remove it (git remote set-url ${binding.remote} ${display}) and let a credential helper keep it (git config credential.helper <helper>), then ask again.`,
      };
    }
    let baseSha = bound.sha;
    if (binding.baseSource !== 'local') {
      if (reaper.blocked()) return { error: grantUnavailable() };
      const fresh = await fetchBase(bound, g);
      if (fresh.error !== undefined) return { error: `The wish did not start: ${fresh.error}` };
      baseSha = fresh.sha;
    }
    return { repo, scope, binding, baseSha, g, evidence, publishTo: scope.length === 0 ? null : bound.url };
  }

  async function claimCopy(root, repo, title, g) {
    const first = slugOf(title);
    const recorded = new Set(load().wishes.map(({ slug }) => slug));
    for (let n = 1; ; n++) {
      const slug = n === 1 ? first : `${first}-${n}`;
      const branch = `wish/${slug}`;
      if (recorded.has(slug) || (await branchExists(repo, branch, g))) continue;
      if (reaper.blocked()) throw new Error(rt.readOnly() ?? 'Genie is unloading.');
      if (realpathSync(root) !== root) throw new Error(`the wishes folder ${root} changed`);
      let claim;
      try {
        // Not recursive: a path something else already holds throws, and nothing is cleaned.
        claim = claimFolder(root, slug);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      copyClaims.add(claim.folder);
      return { ...claim, slug, branch };
    }
  }

  /** Removes a copy no task was given (copy.js checks it is still the claimed folder). */
  function discardClaim(claim) {
    if (reaper.blocked()) return 'failed';
    const why = removeCopy(claim);
    if (why !== 'removed') rt.warn?.('genie: wish copy %s was kept after setup failed (%s)', claim.folder, why);
    return why;
  }

  /** A start that threw after the record was written: see keptNote for what is removed. */
  function failedStart(entry, claim, error, left) {
    let why = 'uncertain';
    try {
      if (error?.levelNotSet === true) why = removeCopy(claim);
      else if (stillClaimed(claim)) why = 'ran';
    } catch {}
    if (why === 'removed') {
      forgetWish(entry);
      return;
    }
    Object.assign(left, { folder: claim.folder, why });
    rt.warn?.('genie: the wish %s did not start and its copy was kept (%s): %s', entry.branch, why, claim.folder);
  }

  function forgetWish(entry) {
    const state = load();
    state.wishes = state.wishes.filter((wish) => wish !== entry);
    try {
      save();
    } catch (error) {
      rt.warn?.('genie: the record of the wish %s stays after its start failed: %s', entry.branch, error.message);
    }
  }

  // A file system with no usable inodes cannot show a swap; such a copy is never removed.
  const swapped = (claim) => claim.identified && !stillClaimed(claim);

  async function makeCopy(plan, claim, store) {
    const { repo, baseSha, g, scope, publishTo } = plan;
    const { folder, branch } = claim;
    const stored = await ensureStore(repo, store, baseSha, g);
    if (!stored.ok) return stored;
    if (reaper.blocked() || swapped(claim)) return { ok: false, error: 'the wish copy claim is no longer valid' };
    const made = await cloneForWish(repo, folder, branch, baseSha, { g, plain: scope.length === 0, store });
    if (!made.ok) return made;
    if (reaper.blocked() || swapped(claim)) return { ok: false, error: 'the wish copy claim is no longer valid' };
    const starts = {};
    if (scope.length > 0) {
      const given = await grantBranches(folder, scope, g);
      if (!given.ok) return given;
      if (publishTo !== null) {
        const published = await addPublishRemote(folder, publishTo, g);
        if (!published.ok) return published;
      }
      for (const name of scope) starts[name] = await commitOf(folder, `refs/heads/${name}`, g, 'given-start');
    }
    return { ok: true, starts };
  }

  async function startWish({ bot, title, wish }, plan, left) {
    if (reaper.blocked()) return grantUnavailable();
    const { repo, scope, binding, baseSha, g, evidence, publishTo } = plan;
    const root = canonicalPath(workspace());
    const project = join(root, basename(repo));
    const store = storeFor(rt.home, repo);
    const unsafe = storeProblem(store, root, project);
    if (unsafe !== null) return `The wish did not start: ${unsafe}.`;
    if (canonicalPath(project) !== project) return `The wish did not start: ${project} is a symlink.`;
    mkdirSync(project, { recursive: true });

    const claim = await claimCopy(project, repo, title, g);
    const { folder, slug, branch } = claim;
    // Settled once the claim is recorded or already discarded; the finally discards the rest.
    let settled = false;
    const fail = (message) => {
      settled = true;
      const why = discardClaim(claim);
      return `The wish did not start: ${message}${why === 'removed' ? '' : keptNote({ folder, why })}`;
    };
    try {
      const made = await makeCopy(plan, claim, store);
      if (!made.ok) return fail(made.error);
      const storeMoved = storeProblem(store, root, folder);
      if (swapped(claim)) return fail('the wish copy claim is no longer valid.');
      if (storeMoved !== null) return fail(`${storeMoved}.`);
      if (reaper.blocked()) return grantUnavailable();
      evidence.baseSha = baseSha;
      const entry = {
        v: WISH_VERSION,
        slug,
        title,
        branch,
        branches: scope,
        starts: made.starts,
        folder,
        repo,
        binding,
        baseSha,
        botId: bot.id,
        at: Date.now(),
        state: 'working',
        evidence,
      };
      // Record ownership before starting a task. If startTask fails after handing off, the
      // sessionless entry remains busy and accounts for the copy on the next start.
      rememberWish(entry);
      settled = true;
      const text = wishBrief({
        title,
        wish,
        folder,
        branch,
        base: baseSha,
        branches: scope,
        canPublish: publishTo !== null,
      });
      try {
        entry.sessionId = await rt.startTask({
          title: `Wish: ${title}`,
          text,
          from: bot.id,
          cwd: folder,
          agentPreset: 'standard',
        });
      } catch (error) {
        // The error thrown is always the start's own, whatever becomes of the copy.
        failedStart(entry, claim, error, left);
        throw error;
      }
      save();
      const early = taskOutcome(rt.state?.tasks?.[entry.sessionId]?.status);
      if (early !== undefined) void settle(entry, early);
      await rt.save();
      return `Wish "${title}" is granted as a thread on branch ${branch}. Its report comes back to you as a message when it ends; do not wait or poll.`;
    } finally {
      copyClaims.delete(folder);
      if (!settled) discardClaim(claim);
    }
  }

  function rememberWish(entry) {
    const state = load();
    const previous = state.wishes;
    let missing = 0;
    state.wishes = [entry, ...previous].filter((wish) => {
      try {
        if (typeof wish.folder === 'string' && lstat(wish.folder)) return true;
      } catch {
        return true;
      }
      return missing++ < WISHES_KEPT;
    });
    try {
      save();
    } catch (error) {
      state.wishes = previous;
      throw error;
    }
  }

  // A wish's turn ends with an outcome (wishes.js: done, stopped, failed, lost). In its copy,
  // the host counts what moved: the wish branch against its base, each given branch against
  // the commit it was given on. The given branches are fetched back on every end (#3184);
  // the wish branch whenever it is ahead, whatever the outcome. Neither is called delivered.
  async function classify(entry, outcome) {
    if (!awaitsEnd(entry)) return;
    const evidence = entry.evidence ?? newEvidence();
    entry.evidence = evidence;
    const g = gitRunner({ note: (command) => noteCommand(evidence, command) });
    const { repo, folder, branch } = entry;
    // A v1 record (granted before v2) names its base commit `base`.
    const baseSha = entry.baseSha ?? entry.base;
    const errors = [];
    const head = await commitOf(folder, `refs/heads/${branch}`, g, 'wish-head');
    const ahead =
      head === null || typeof baseSha !== 'string' ? null : await aheadOf(folder, baseSha, head, g, 'wish-ahead');
    const given = {};
    for (const name of entry.branches ?? []) {
      const start = entry.starts?.[name];
      const tip = await commitOf(folder, `refs/heads/${name}`, g, 'given-head');
      // A v1 scoped record has no start commits: its branch moved when fetching it back
      // changes the project's branch.
      const before = start === undefined ? await commitOf(repo, `refs/heads/${name}`, g, 'given-before') : undefined;
      const back = await fetchWishBranch(repo, folder, name, g);
      if (!back.ok) errors.push(`${name}: ${back.error}`);
      let moved;
      let count = null;
      if (start === undefined) moved = (await commitOf(repo, `refs/heads/${name}`, g, 'given-after')) !== before;
      else {
        count = tip === null ? null : await aheadOf(folder, start, tip, g, 'given-ahead');
        moved = tip !== null && tip !== start;
      }
      given[name] = { start: start ?? before ?? null, head: tip, ahead: count, moved, fetch: back.code };
    }
    if (ahead !== null && ahead > 0) {
      const back = await fetchWishBranch(repo, folder, branch, g);
      if (!back.ok) errors.push(`${branch}: ${back.error}`);
    }
    let state;
    if (head === null || ahead === null) {
      // What the copy holds cannot be read, so nothing is claimed for it.
      errors.unshift(`${branch} could not be read in ${folder}`);
      state = outcome === 'done' ? 'failed' : outcome;
    } else state = endedState(outcome, ahead > 0 || Object.values(given).some((b) => b.moved));
    Object.assign(evidence, { baseSha: baseSha ?? null, headSha: head, ahead });
    if (Object.keys(given).length > 0) evidence.given = given;
    entry.state = state;
    entry.endedAt = Date.now();
    if (errors.length > 0) {
      entry.error = errors.join('; ');
      rt.warn?.('genie: wish %s: %s', branch, entry.error);
    } else entry.error = undefined; // JSON drops it
    save();
  }

  // Each wish is settled once, however its end is learnt (the live turn end, the startup pass,
  // the check right after the grant): its session is claimed here, synchronously, before any
  // await. A `lost` wish is the one exception: a task the team trimmed from its records can
  // still be running, so its live end settles it again, after the lost pass.
  const claims = new Map();
  function settle(entry, outcome) {
    const prior = claims.get(entry.sessionId);
    if (prior !== undefined && (prior.outcome !== 'lost' || outcome === 'lost')) return prior.done;
    const done = withCopies(async () => {
      if (!reaper.blocked()) await classify(entry, outcome);
    }).catch((error) => rt.warn?.('genie: wish %s: %s', entry.branch, error?.message ?? error));
    void done.then(sweepSoon);
    claims.set(entry.sessionId, { outcome, done });
    return done;
  }

  // Live: the turn end this plugin receives says how the task ended. A turn a restart cut is
  // no end (the team resumes it), nor is a blocked one (it goes on in a fresh part). The
  // team's task record is not read here, so the order of the listeners does not matter.
  ctx.on?.('session/event', (session, event) => {
    const entry = load().wishes.find((wish) => wish.sessionId && wish.sessionId === session?.id);
    if (!entry || !event) return;
    reaper.observe(session.id, event);
    if (event.type === 'approval/decided' && !awaitsEnd(entry)) void sweepSoon();
    if (event.type !== 'turn/end' || rt.cutByRestart?.(event.data?.reason)) return;
    const outcome = turnOutcome(event.data?.reason);
    if (outcome === undefined) return;
    if (awaitsEnd(entry)) void settle(entry, outcome);
    else void sweepSoon();
  });

  // Startup: a wish whose task ended while this plugin was not listening takes the team's
  // recorded status, once the team's resume pass is over. Only on a host that writes the
  // team, and only from a tasks record that was read: a wish missing from it is `lost`
  // (the team keeps its newest 60 tasks), never done.
  async function reconcile() {
    await rt.load();
    if (typeof rt.resumesDone?.then !== 'function') return;
    const resumes = await rt.resumesDone;
    if (reaper.blocked() || resumes === null || typeof resumes !== 'object') return;
    if (Object.hasOwn(resumes, 'readOnly') || Object.hasOwn(resumes, 'failed')) return;
    const tasks = rt.state?.tasks;
    if (tasks === null || typeof tasks !== 'object') return;
    readHistory(file());
    const settling = [];
    for (const entry of load().wishes) {
      if (entry.v !== WISH_VERSION || entry.state !== 'working' || !entry.sessionId) continue;
      const outcome = Object.hasOwn(tasks, entry.sessionId) ? taskOutcome(tasks[entry.sessionId]?.status) : 'lost';
      if (outcome !== undefined) settling.push(settle(entry, outcome));
    }
    await Promise.all(settling);
  }
  const reconciled = ready
    .then(reconcile)
    .catch((error) => rt.warn?.('genie: the wishes were not reconciled: %s', error?.message ?? error))
    .then(sweepSoon);

  async function sweepSoon() {
    try {
      await sweep();
    } catch (error) {
      rt.warn?.('genie: wish copies were not swept: %s', error?.message ?? error);
    }
  }

  // Every answer to a browser's state request, right after the team took that browser's locale
  // (bots-dsh channel.js): the first moment the team can know the language.
  ctx.effect(
    () =>
      rt.hooks.live(() => {
        nameTheLanguage();
        return {};
      }),
    'genie: Genies told the interface language',
  );

  // Adding a Genie: genie-create { folder } answers { bot: { id, name, color }, existed }.
  ctx.effect(() => rt.hooks.endpoint?.('genie-create', (body) => createGenie(body ?? {})), 'genie: create a Genie');

  // The wishes, for the rows under Genie; their status is the team's task status.
  ctx.effect(
    () =>
      rt.hooks.view(() => ({
        genie: {
          // Which Genie colors are worn, so a picker offers only the free ones.
          colors: GENIE_COLORS,
          taken: genieBots().map(genieColorOf),
          // A v2 wish carries its state (wishes.js), which the row shows instead of the task status.
          wishes: load()
            .wishes.slice(0, WISHES_KEPT)
            .map(({ slug, title, branch, sessionId, botId, at, state }) => ({
              slug,
              title,
              branch,
              sessionId,
              botId,
              at,
              ...(state === undefined ? {} : { state }),
            })),
        },
      })),
    'genie: wishes in the team view',
  );

  ctx.tools.register(
    defineTool({
      name: 'grant_wish',
      description:
        'Genie only. Grants one wish in your project: a new thread works on it in its own copy of the project, on a new branch from the base as the remote has it now, commits there without pushing, then reports back to you. Write the wish so it stands on its own: the thread cannot see this chat. A follow-up that must repair or publish branches an earlier wish made names them in branches: it may commit on, push and open PRs for exactly those, never merge.',
      parameters: {
        title: { type: 'string', required: true, description: 'A few words the user will see as the thread name' },
        wish: {
          type: 'string',
          required: true,
          description: 'The whole wish: the goal, what done looks like, anything to keep in mind',
        },
        branches: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Optional. Existing branches an earlier wish made that this wish may change besides its own: commit repairs on them, push them to the project's remote and open or update their PRs. Only branches the user named, never the project's integration branch.",
        },
      },
      output,
      async execute(args, exec) {
        await ready;
        await rt.load();
        const self = rt.selfOf(exec.agent?.id);
        const bot = rt.botOf(self);
        if (bot?.kind !== GENIE_KIND) return 'Only Genie grants wishes. Ask Genie in its chat.';
        const readOnly = rt.readOnly();
        if (readOnly !== undefined) return readOnly;
        const title = String(args.title ?? '').trim();
        const wish = String(args.wish ?? '').trim();
        if (title === '' || wish === '') return 'A wish needs a title and the wish itself.';
        const left = {};
        try {
          return await grantWish({ bot, title, wish, branches: args.branches }, left);
        } catch (error) {
          const said = `The wish did not start: ${error?.message ?? error}`;
          return `${said}${keptNote(left)}`;
        }
      },
    }),
  );

  Object.assign(rt, {
    ensureGenie,
    createGenie,
    grantWish,
    genieWishes: () => load().wishes,
    genieReady: ready,
    genieReconciled: reconciled,
    genieSweep: sweep,
    genieCopiesFile: reaper.file,
  });
}
