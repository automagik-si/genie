import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, sameInode } from './paths.js';

function readOptional(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readHistory(file) {
  const text = readOptional(file);
  if (text === undefined) return { genieCreated: false, wishes: [] };
  const data = JSON.parse(text);
  if (!Array.isArray(data?.wishes) || data.wishes.some((wish) => !wish || typeof wish !== 'object')) {
    throw new Error('wish history has no valid wish list');
  }
  return { genieCreated: data.genieCreated === true, wishes: data.wishes };
}

export function writeJson(file, data) {
  const temp = `${file}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

const timestamp = () => new Date().toISOString();

export function copyLedger(keptFile, journal) {
  let inspection;
  const report = (kept, now) => writeJson(keptFile, { v: 1, at: new Date(now).toISOString(), kept, inspection });

  function append(entry) {
    const fd = openSync(journal, 'a', 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  function remember(folder, stat, reason) {
    inspection[folder] = { dev: stat?.dev, ino: stat?.ino, reason };
  }

  function recover() {
    if (inspection !== undefined) return;
    const prior = JSON.parse(readOptional(keptFile) ?? '{}');
    if (
      prior.inspection !== undefined &&
      (prior.inspection === null || typeof prior.inspection !== 'object' || Array.isArray(prior.inspection))
    ) {
      throw new Error('wish copy inspection report is unreadable');
    }
    inspection = Object.assign(Object.create(null), prior.inspection);
    try {
      const pending = new Map();
      for (const line of (readOptional(journal) ?? '').split('\n').filter(Boolean)) {
        const row = JSON.parse(line);
        if (row.state === 'removing') pending.set(row.id, row);
        else pending.delete(row.id);
      }
      for (const row of pending.values()) {
        let state = 'inspection-required';
        try {
          const stat = lstat(row.folder);
          if (!stat) state = 'absent-on-recovery';
          else remember(row.folder, stat, state);
        } catch {
          remember(row.folder, row, state);
        }
        if (state === 'inspection-required') report(prior.kept ?? [], Date.now());
        append({ id: row.id, at: timestamp(), state });
      }
    } catch (error) {
      inspection = undefined;
      throw error;
    }
  }

  function held(scope) {
    for (const [folder, item] of Object.entries(inspection)) {
      if (!scope(folder)) continue;
      try {
        const stat = lstat(folder);
        if (!stat || (item.dev !== undefined && !sameInode(item, stat))) delete inspection[folder];
      } catch {
        // An unreadable path still occupies a slot.
      }
    }
    return inspection;
  }

  function intent(entry, stat) {
    const id = randomUUID();
    append({ id, at: timestamp(), state: 'removing', ...entry, dev: stat.dev, ino: stat.ino });
    return id;
  }

  function outcome(id, folder, stat, error, kept, now) {
    if (error !== undefined) {
      remember(folder, stat, 'remove-failed');
      report(kept, now);
      append({ id, at: timestamp(), state: 'remove-failed', error });
    } else {
      append({ id, at: timestamp(), state: 'removed' });
    }
  }

  return { recover, held, intent, outcome, report };
}
