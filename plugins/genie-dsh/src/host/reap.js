import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { copyLedger, readHistory } from './copy-state.js';
import { canonicalPath, lstat, within } from './paths.js';
import { IDLE_MS, configOf, copyVerdict, inspectionGit, stillSameCopy } from './reap-gates.js';
import { awaitsEnd } from './wishes.js';

const LIVE_COPIES_MAX = 8;
const MAX_RETRY_MS = 6 * 60 * 60_000;
const REFUSAL_ADVICE = 'Commit or bring back that work, or delete a copy you do not need, then ask again.';
const trackedEvents = new Set(['turn/start', 'turn/end', 'approval/asked', 'approval/decided']);
const slugPattern = /^[a-z0-9][a-z0-9-]*$/;
const inRoot = (root, path) => typeof path === 'string' && path !== root && dirname(dirname(path)) === root;

function listedFolders(root) {
  if (!lstat(root)) return [];
  const folders = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      folders.push(join(directory, child.name));
    }
  }
  return folders;
}

function recordedCopies(root, wishes) {
  const records = new Map();
  for (const wish of wishes) {
    if (typeof wish.folder !== 'string') continue;
    // Resolve an alias to the root without following a link in the candidate slot.
    const folder = join(canonicalPath(dirname(wish.folder)), basename(wish.folder));
    if (inRoot(root, folder)) records.set(folder, { ...wish, folder });
  }
  return records;
}

async function corroboratedLegacy(git, folder) {
  try {
    const gitDir = join(folder, '.git');
    const head = join(gitDir, 'HEAD');
    if (!slugPattern.test(basename(folder)) || !lstat(folder)?.isDirectory() || !lstat(gitDir)?.isDirectory()) {
      return false;
    }
    if (!lstat(head)?.isFile() || readFileSync(head, 'utf8').trim() !== `ref: refs/heads/wish/${basename(folder)}`) {
      return false;
    }
    const origins = (await configOf(git, join(gitDir, 'config')))?.filter(([key]) => key === 'remote.origin.url');
    return origins?.length === 1 && isAbsolute(origins[0][1]) && lstat(origins[0][1])?.isDirectory();
  } catch {
    return false;
  }
}

function activityTracker(rt) {
  const { ctx } = rt;
  const events = new Map();

  function observe(id, event) {
    if (!trackedEvents.has(event.type)) return;
    const state = events.get(id) ?? { openTurn: false, approvals: new Set() };
    state.lastEventAt = Date.now();
    if (event.type === 'turn/start') state.openTurn = true;
    if (event.type === 'turn/end') state.openTurn = false;
    if (event.type === 'approval/asked') state.approvals.add(event.data?.id);
    if (event.type === 'approval/decided') state.approvals.delete(event.data?.id);
    events.set(id, state);
  }

  function tracked(copy, now) {
    const { sessionId } = copy;
    const state = events.get(sessionId);
    if (!sessionId || awaitsEnd(copy) || state?.openTurn || state?.approvals.size) return { keep: 'working' };
    const deadline = state ? state.lastEventAt + IDLE_MS : 0;
    return now < deadline ? { keep: 'recent', deadline } : {};
  }

  function activeAgent(agent, copy) {
    // dsh-agent AgentRegistry.list() is synchronous. Archive admission uses 'running',
    // which includes a turn awaiting approval. The team can also expose pending approvals.
    const running = agent.status === 'running' || rt.waitsForApproval?.(agent.id);
    if (!running) return false;
    if (agent.id === copy.sessionId) return true;
    const cwd = agent.session?.meta?.cwd;
    return typeof cwd === 'string' && within(copy.folder, canonicalPath(cwd));
  }

  function live(copy, now) {
    try {
      const result = ctx.agents?.list();
      const check = (agents) => {
        if (!Array.isArray(agents)) return { keep: 'activity-unknown' };
        if (agents.some((agent) => activeAgent(agent, copy)) || rt.waitsForApproval?.(copy.sessionId)) {
          return { keep: 'working', deadline: now + IDLE_MS };
        }
        return tracked(copy, now);
      };
      if (typeof result?.then === 'function') {
        return Promise.resolve(result)
          .then(check)
          .catch(() => ({ keep: 'activity-unknown' }));
      }
      return check(result);
    } catch {
      return { keep: 'activity-unknown' };
    }
  }

  return { observe, tracked, live, forget: (id) => events.delete(id) };
}

function describe(folder, reason) {
  return { project: basename(dirname(folder)), slug: basename(folder), folder, reasons: [reason] };
}

function removeFolder(folder) {
  try {
    fs.rmSync(folder, { recursive: true });
    if (lstat(folder)) return 'the folder still exists after removal';
    return undefined;
  } catch (error) {
    return error.message;
  }
}

function survivingInode(folder, fallback) {
  try {
    return lstat(folder) ?? fallback;
  } catch {
    return fallback;
  }
}

export function createReaper(rt, { workspace, history, claims, retry }) {
  const file = join(rt.home, 'genie-copies-kept.json');
  const ledger = copyLedger(file, join(rt.home, 'genie-copies-removed.jsonl'));
  const activity = activityTracker(rt);
  let timer;
  let disposed = false;

  const blocked = () => disposed || rt.readOnly() !== undefined;
  rt.ctx.effect(
    () => () => {
      disposed = true;
      clearTimeout(timer);
    },
    'genie: wish copy sweep timer',
  );

  function schedule(deadline) {
    clearTimeout(timer);
    if (blocked() || !Number.isFinite(deadline)) return;
    const delay = Math.max(60_000, Math.min(deadline - Date.now(), MAX_RETRY_MS));
    timer = setTimeout(retry, delay);
    timer.unref?.();
  }

  async function consider({ copy, root, git, now, kept }) {
    const verdict = () => copyVerdict({ copy, root, now, git, home: rt.home, activity: activity.live });
    const first = await verdict();
    if (first.keep || blocked()) return first;
    const final = await verdict();
    if (final.keep || blocked()) return final;
    // The synchronous registry check, tracked-event recheck and inode comparison share the
    // same host turn as rmSync. If a future registry is async, finish its await first.
    const live = activity.live(copy, now);
    const settled = typeof live?.then === 'function' ? await live : live;
    if (settled.keep || blocked()) return settled;
    const current = activity.tracked(copy, now);
    if (current.keep) return current;
    try {
      readHistory(history());
    } catch {
      return { keep: 'history-unreadable' };
    }
    try {
      if (!stillSameCopy(copy.folder, first) || !stillSameCopy(copy.folder, final)) {
        return holdChangedCopy(copy, first, final, kept, now);
      }
    } catch {
      return holdChangedCopy(copy, first, final, kept, now);
    }
    const id = ledger.intent(removalDetails(copy, final), final.stat);
    const error = removeFolder(copy.folder);
    const stat = error === undefined ? final.stat : survivingInode(copy.folder, final.stat);
    ledger.outcome(id, copy.folder, stat, error, kept, now);
    if (error !== undefined) return { keep: 'remove-failed' };
    activity.forget(copy.sessionId);
    return {};
  }

  function removalDetails(copy, { sha, branch, bytes }) {
    const { folder, slug } = copy;
    return {
      project: basename(dirname(folder)),
      folder,
      slug,
      branch,
      sha,
      bytes,
      reason: `ended:${copy.state ?? 'v1'}, work in project`,
    };
  }

  function holdChangedCopy(copy, first, final, kept, now) {
    const id = ledger.intent(removalDetails(copy, final), first.stat);
    const stat = survivingInode(copy.folder, first.stat);
    ledger.outcome(id, copy.folder, stat, 'copy identity changed before removal', kept, now);
    return { keep: 'remove-failed' };
  }

  async function scan({ now = Date.now() } = {}) {
    if (blocked()) return { stopped: true };
    const root = canonicalPath(workspace());
    const scope = (folder) => inRoot(root, folder);
    ledger.recover();
    const inspection = ledger.held(scope);
    let records;
    try {
      records = recordedCopies(root, readHistory(history()).wishes);
    } catch {
      const kept = listedFolders(root).map((folder) => describe(folder, 'history-unreadable'));
      if (kept.length === 0) kept.push(describe(root, 'history-unreadable'));
      ledger.report(kept, now);
      return { historyUnreadable: true };
    }
    const kept = [];
    const counted = [];
    const seen = new Set([...listedFolders(root), ...claims, ...Object.keys(inspection).filter(scope)]);
    for (const folder of records.keys()) {
      try {
        if (lstat(folder)) seen.add(folder);
      } catch {
        seen.add(folder);
      }
    }
    const result = await scanFolders({ root, records, inspection, seen, kept, counted, now });
    if (blocked()) return { stopped: true };
    ledger.report(kept, now);
    schedule(result.deadline);
    return { count: counted.length, kept: counted };
  }

  async function scanFolders({ root, records, inspection, seen, kept, counted, now }) {
    let deadline = Number.POSITIVE_INFINITY;
    if (seen.size === 0) return { deadline };
    const temp = mkdtempSync(join(tmpdir(), 'genie-copy-inspect-'));
    const git = inspectionGit(temp);
    try {
      for (const folder of seen) {
        if (blocked()) break;
        const copy = records.get(folder);
        const reason = inspection[folder]?.reason ?? (claims.has(folder) ? 'working' : null);
        const verdict = reason ? { keep: reason } : await checkFolder(folder, { copy, root, git, now, kept });
        if (!verdict.keep) continue;
        const item = describe(folder, verdict.keep);
        kept.push(item);
        if (copy || reason || verdict.keep === 'no-record') counted.push(item);
        deadline = Math.min(deadline, verdict.deadline ?? Number.POSITIVE_INFINITY);
      }
      return { deadline };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  async function checkFolder(folder, options) {
    if (options.copy) return consider(options);
    return { keep: (await corroboratedLegacy(options.git, folder)) ? 'no-record' : 'not-a-copy' };
  }

  function refuse({ count, kept }) {
    if (count < LIVE_COPIES_MAX) return null;
    const first = kept
      .slice(0, 5)
      .map(({ slug, reasons }) => `${slug} (${reasons.join(', ')})`)
      .join(', ');
    const limit = `Genie keeps at most ${LIVE_COPIES_MAX} wish copies and ${count} are on disk`;
    const why = `kept because their work is not safe to remove yet: ${first}. The full list is in ${file}`;
    return `The wish did not start: ${limit}, ${why}. ${REFUSAL_ADVICE}`;
  }

  return { file, scan, blocked, observe: activity.observe, refuse };
}
