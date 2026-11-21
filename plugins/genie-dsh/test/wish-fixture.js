import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { GENIE_KIND } from '../src/host/genie.js';
import { compose, fakeTeam, gitIn, grant, savedWishes, until } from './team.js';

export function scratch(prefix) {
  const dir = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', prefix));
  // The test host lives under the fixture root. Model a system temp location
  // separate from that root, as on a normal host with a persistent team home.
  mock.method(os, 'tmpdir', () => '/tmp');
  process.env.GENIE_WISHES_DIR = join(dir, 'wishes');
  return dir;
}

export function commit(dir, message, file = 'f.txt') {
  writeFileSync(join(dir, file), message);
  gitIn(dir, 'add', '--', file);
  gitIn(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message);
  return gitIn(dir, 'rev-parse', 'HEAD');
}

export function localRepo(dir, name = 'app') {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  gitIn(repo, 'init', '-qb', 'dev');
  commit(repo, 'base');
  return repo;
}

export function host(dir, repo, options, context) {
  const team = fakeTeam(dir, {
    bots: { g: { id: 'g', name: 'Genie', kind: GENIE_KIND, workDir: repo } },
    ...options,
  });
  return { team, ...compose(team, context) };
}

export async function wish(host, title, branches) {
  const answer = await grant(host.tools, 'g', {
    title,
    wish: 'Implement the wish.',
    ...(branches ? { branches } : {}),
  });
  return { answer, entry: host.team.record.tasks.length > 0 ? savedWishes(host.team)[0] : undefined };
}

export async function end(host, entry, state = 'no-change') {
  host.turnEnd(entry.sessionId);
  return until(() => savedWishes(host.team).find((w) => w.slug === entry.slug && w.state === state));
}
