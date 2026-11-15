/**
 * sqlite-open — the shared open primitive's busy classification, plus the
 * poisoned-WAL-index recovery helper it deliberately does NOT call.
 *
 * `openSqlite` is the fleet hot path (`genie task`, `task sync`, the git-hook
 * sync) and stays churn-free; the recovery is opt-in
 * and was wired only into the retired MCP write open, the path that created the
 * poison. No shipped caller remains, so these tests are the whole contract:
 * they drive the helper directly — predicates, retry contract, and the
 * live-peer skips that keep it from touching a contended database.
 * genie-db.test.ts pins that the shared path does not heal it.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUSY_DEADLINE_MS,
  BUSY_TIMEOUT_MS,
  BusyDbError,
  type BusyWait,
  ForeignDbError,
  MalformedDbError,
  PendingMigrationError,
  busyBackoffMs,
  isBusyError,
  openSqlite,
  retryBusy,
} from './sqlite-open.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-sqlite-open-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('isBusyError', () => {
  test('classifies the whole SQLITE_BUSY/SQLITE_LOCKED family, including extended codes', () => {
    // A raw `db.query(...)` throw carries the EXTENDED code; only the primary
    // code in the low byte is stable, so the classifier must read that.
    const recovery = Object.assign(new Error('database is busy'), {
      code: 'SQLITE_BUSY_RECOVERY',
      errno: 261, // SQLITE_BUSY | (1 << 8)
    });
    expect(isBusyError(recovery)).toBe(true);
    expect(isBusyError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errno: 5 }))).toBe(true);
    expect(isBusyError(Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED_SHAREDCACHE', errno: 262 }))).toBe(
      true,
    );
    expect(isBusyError(new BusyDbError('/tmp/x.db', new Error('database is locked'), 120_000))).toBe(true);
    // SQLITE_PROTOCOL (15) is a lost WAL-index lock race under heavy contention,
    // not corruption — it must retry, never surface as "malformed".
    expect(isBusyError(Object.assign(new Error('locking protocol'), { code: 'SQLITE_PROTOCOL', errno: 15 }))).toBe(
      true,
    );
    // The poison's own failure shape must NOT be classified busy — that is what
    // routes it into recovery instead of the busy carve-out.
    expect(isBusyError(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE', errno: 778 }))).toBe(
      false,
    );
    expect(isBusyError(Object.assign(new Error('readonly'), { code: 'SQLITE_READONLY', errno: 8 }))).toBe(false);
    expect(isBusyError(new Error('some other failure'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The busy deadline (#3315): one wall-clock limit shared with the Rust store,
// jittered backoff under a cap, and an error that says what happened. Every
// test runs on a made-up clock and a fake sleep — nothing here really waits.
// ---------------------------------------------------------------------------
describe('retryBusy wall-clock deadline', () => {
  const PATH = '/repo/.genie/genie.db';

  /** A made-up clock that only `sleep`, or an attempt calling `advance`, moves. */
  function fakeWait(random: () => number = () => 0) {
    const state = { elapsed: 0, pauses: [] as number[] };
    const wait: BusyWait = {
      now: () => 1_000 + state.elapsed,
      sleep: (ms) => {
        state.pauses.push(ms);
        state.elapsed += ms;
      },
      random,
    };
    const advance = (ms: number): void => {
      state.elapsed += ms;
    };
    return { wait, state, advance };
  }

  /** A fixed pseudo-random sequence in [0, 1), so a jittered run is the same run every time. */
  function lcg(): () => number {
    let seed = 0x2545f491;
    return () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
  }

  const sqliteError = (message: string, code: string, errno: number) =>
    Object.assign(new Error(message), { code, errno });
  const busy = () => sqliteError('database is locked', 'SQLITE_BUSY', 5);

  /** `[d/2, d]` for busy result `attempt`, in milliseconds. */
  const range = (attempt: number): [number, number] => {
    const ceiling = Math.min(25 * 2 ** attempt, 1_000);
    return [Math.floor(ceiling / 2), ceiling];
  };

  test('a first-try success neither sleeps nor retries', () => {
    const { wait, state } = fakeWait();
    let calls = 0;
    const got = retryBusy(
      PATH,
      () => {
        calls++;
        return 7;
      },
      wait,
    );
    expect(got).toBe(7);
    expect(calls).toBe(1);
    expect(state.pauses).toEqual([]);
    expect(state.elapsed).toBe(0);
  });

  test('busy results inside the deadline are retried until one succeeds', () => {
    const { wait, state, advance } = fakeWait(lcg());
    let calls = 0;
    const got = retryBusy(
      PATH,
      () => {
        calls++;
        if (calls > 9) return 'committed';
        // Each busy attempt first spends a whole busy_timeout inside SQLite.
        advance(BUSY_TIMEOUT_MS);
        throw busy();
      },
      wait,
    );
    expect(got).toBe('committed');
    expect(calls).toBe(10);
    expect(state.pauses).toHaveLength(9);
    state.pauses.forEach((pause, attempt) => {
      const [floor, ceiling] = range(attempt);
      expect(pause).toBeGreaterThanOrEqual(floor);
      expect(pause).toBeLessThanOrEqual(ceiling);
    });
    expect(state.elapsed).toBeLessThan(BUSY_DEADLINE_MS);
  });

  test('every busy-family code is retried', () => {
    for (const err of [
      busy(),
      sqliteError('database is locked', 'SQLITE_BUSY_SNAPSHOT', 517),
      sqliteError('database table is locked', 'SQLITE_LOCKED', 6),
      sqliteError('locking protocol', 'SQLITE_PROTOCOL', 15),
    ]) {
      const { wait } = fakeWait();
      let calls = 0;
      retryBusy(
        PATH,
        () => {
          calls++;
          if (calls === 1) throw err;
        },
        wait,
      );
      expect(calls).toBe(2);
    }
  });

  test('the deadline fails at once with what happened by effect', () => {
    // Busy forever and every attempt instant: the pauses alone reach the
    // deadline, and the last one is clamped to it.
    const { wait, state } = fakeWait(lcg());
    const starts: number[] = [];
    let thrown: unknown;
    try {
      retryBusy(
        PATH,
        () => {
          starts.push(state.elapsed);
          throw busy();
        },
        wait,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BusyDbError);
    const err = thrown as BusyDbError;
    expect(err.waitedMs).toBe(BUSY_DEADLINE_MS);
    expect(state.elapsed).toBe(BUSY_DEADLINE_MS);
    expect(starts.at(-1)).toBe(BUSY_DEADLINE_MS);
    expect(state.pauses.reduce((a, b) => a + b, 0)).toBe(BUSY_DEADLINE_MS);
    expect(Math.max(...state.pauses)).toBeLessThanOrEqual(1_000);
    // Past the ramp a waiting writer polls once every 0.5-1 s: no spin, no minute-long sleep.
    expect(starts.length).toBeGreaterThanOrEqual(120);
    expect(starts.length).toBeLessThanOrEqual(250);
    expect(err.path).toBe(PATH);
    expect(err.message).toBe(
      'The task database /repo/.genie/genie.db stayed locked for 120 s; another genie process may be stuck, or the disk is stalled. Safe to retry once it clears (database is locked)',
    );
    expect(err).not.toBeInstanceOf(MalformedDbError);
  });

  test('an attempt running at the deadline finishes and the error reports the measured time', () => {
    // Two statements that each wait out a whole busy_timeout.
    const attemptMs = 2 * BUSY_TIMEOUT_MS;
    const { wait, state, advance } = fakeWait(() => 0.999);
    const starts: number[] = [];
    let thrown: unknown;
    try {
      retryBusy(
        PATH,
        () => {
          starts.push(state.elapsed);
          advance(BUSY_TIMEOUT_MS);
          advance(BUSY_TIMEOUT_MS);
          throw busy();
        },
        wait,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BusyDbError);
    const err = thrown as BusyDbError;
    expect(Math.max(...starts)).toBeLessThanOrEqual(BUSY_DEADLINE_MS);
    expect(err.waitedMs).toBe(state.elapsed);
    // The overshoot is the whole last attempt, not one busy_timeout: the bound is deadline + one attempt.
    expect(err.waitedMs).toBe((starts.at(-1) as number) + attemptMs);
    expect(err.waitedMs).toBeGreaterThanOrEqual(BUSY_DEADLINE_MS);
    expect(err.waitedMs).toBeLessThanOrEqual(BUSY_DEADLINE_MS + attemptMs);
    expect(err.message).toContain(`stayed locked for ${Math.floor(err.waitedMs / 1000)} s;`);
  });

  test('any other throw passes through at once without a retry', () => {
    for (const failure of [
      sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778),
      sqliteError('attempt to write a readonly database', 'SQLITE_READONLY', 8),
      new MalformedDbError(PATH, new Error('file is not a database')),
      new ForeignDbError(PATH, 9, 2, 'unrecognized schema version'),
    ]) {
      const { wait, state } = fakeWait();
      let calls = 0;
      expect(() =>
        retryBusy(
          PATH,
          () => {
            calls++;
            throw failure;
          },
          wait,
        ),
      ).toThrow(failure);
      expect(calls).toBe(1);
      expect(state.pauses).toEqual([]);
    }
  });

  test('the backoff doubles to its cap and is jittered between half and whole', () => {
    const top = 1 - Number.EPSILON;
    [25, 50, 100, 200, 400, 800, 1_000, 1_000, 1_000].forEach((ceiling, attempt) => {
      expect(busyBackoffMs(attempt, 0)).toBe(Math.floor(ceiling / 2));
      expect(busyBackoffMs(attempt, top)).toBe(ceiling);
    });
    expect(busyBackoffMs(1_000_000, 0)).toBe(500);
    expect(busyBackoffMs(1_000_000, top)).toBe(1_000);
    const spread = new Set(Array.from({ length: 200 }, () => busyBackoffMs(6, Math.random())));
    for (const ms of spread) {
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThanOrEqual(1_000);
    }
    expect(spread.size).toBeGreaterThan(20);
  });

  test('crates/genie-tasks/src/store.rs declares the same deadline, busy_timeout and backoff', () => {
    const rust = readFileSync(join(import.meta.dir, '../../../crates/genie-tasks/src/store.rs'), 'utf8');
    const rustMs = (name: string): number => {
      const match = rust.match(
        new RegExp(`^(?:pub )?const ${name}: Duration = Duration::from_millis\\(([\\d_]+)\\);$`, 'm'),
      );
      if (match?.[1] === undefined) throw new Error(`store.rs declares no ${name}`);
      return Number(match[1].replaceAll('_', ''));
    };
    expect(rustMs('BUSY_DEADLINE')).toBe(BUSY_DEADLINE_MS);
    expect(rustMs('BUSY_TIMEOUT')).toBe(BUSY_TIMEOUT_MS);
    // The TS backoff constants are module-private; its first ceiling and its cap are what they set.
    expect(rustMs('BUSY_BACKOFF_BASE')).toBe(busyBackoffMs(0, 1 - Number.EPSILON));
    expect(rustMs('BUSY_BACKOFF_CAP')).toBe(busyBackoffMs(1_000_000, 1 - Number.EPSILON));
  });
});

// ---------------------------------------------------------------------------
// The forward-only migration ladder (`OpenSqliteOptions.migrations`).
//
// Driven here against a synthetic schema rather than genie.db, so the contract
// is pinned independently of what the per-repo database happens to declare:
// plan-before-apply, per-step transactional stamping, the decline switch, and
// the two refusals.
// ---------------------------------------------------------------------------
describe('openSqlite migration ladder', () => {
  const ensureSchema = (db: Database): void => {
    db.exec('CREATE TABLE IF NOT EXISTS kept (id INTEGER PRIMARY KEY)');
  };

  /** A database stamped `version` carrying `kept` plus every name in `extra`. */
  function seed(name: string, version: number, extra: string[] = []): string {
    const path = join(base, name);
    const db = new Database(path);
    db.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)');
    db.query('INSERT INTO kept (id) VALUES (1)').run();
    for (const table of extra) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    return path;
  }

  const userVersion = (path: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  };

  const tables = (path: string): string[] => {
    const db = new Database(path, { readonly: true });
    try {
      return (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  };

  test('a complete chain climbs every rung and lands on schemaVersion', () => {
    const path = seed('chain.db', 1, ['gone_at_2', 'gone_at_3']);
    const seen: number[] = [];
    const db = openSqlite({
      path,
      schemaVersion: 3,
      ensureSchema,
      migrations: [
        {
          from: 2,
          to: 3,
          apply: (handle) => {
            seen.push(3);
            handle.exec('DROP TABLE gone_at_3');
          },
        },
        {
          from: 1,
          to: 2,
          apply: (handle) => {
            seen.push(2);
            handle.exec('DROP TABLE gone_at_2');
          },
        },
      ],
    });
    db.close();
    // Declared out of order, applied in ascending `from` order.
    expect(seen).toEqual([2, 3]);
    expect(userVersion(path)).toBe(3);
    expect(tables(path)).toEqual(['kept']);
  });

  test('an incomplete chain refuses BEFORE applying any step', () => {
    // The 1 -> 2 rung exists and 2 -> 3 does not. A ladder that applied as it
    // walked would drop `gone_at_2` and leave the file stamped 2 under a build
    // that expects 3 — unrecoverable. Planning first means nothing runs.
    const path = seed('gap.db', 1, ['gone_at_2']);
    let applied = 0;
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 3,
        ensureSchema,
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              applied++;
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      }),
    ).toThrow(ForeignDbError);
    expect(applied).toBe(0);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('a database with no ladder at all still refuses, untouched', () => {
    const path = seed('noladder.db', 1);
    expect(() => openSqlite({ path, schemaVersion: 2, ensureSchema })).toThrow(ForeignDbError);
    expect(userVersion(path)).toBe(1);
  });

  test('each step stamps its own `to` inside its own transaction', () => {
    // Observed from INSIDE the next step: if the stamp were deferred to the end
    // of the chain this reads 1, and a process killed here would leave migrated
    // tables under a stale version.
    const path = seed('stamp.db', 1, ['gone_at_2']);
    let seenFromStep3 = -1;
    const db = openSqlite({
      path,
      schemaVersion: 3,
      ensureSchema,
      migrations: [
        { from: 1, to: 2, apply: (handle) => handle.exec('DROP TABLE gone_at_2') },
        {
          from: 2,
          to: 3,
          apply: (handle) => {
            seenFromStep3 = (handle.query('PRAGMA user_version').get() as { user_version: number }).user_version;
          },
        },
      ],
    });
    db.close();
    expect(seenFromStep3).toBe(2);
    expect(userVersion(path)).toBe(3);
  });

  test('a step that throws rolls back its DDL AND its stamp', () => {
    // The crash-between-DDL-and-stamp window: with the stamp inside the same
    // transaction there is no such window, so the file is exactly as it was.
    const path = seed('rollback.db', 1, ['gone_at_2']);
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              handle.exec('DROP TABLE gone_at_2');
              throw new Error('killed mid-step');
            },
          },
        ],
      }),
    ).toThrow('killed mid-step');
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('two concurrent openers converge: one migration, no corruption, both current', async () => {
    const path = seed('concurrent.db', 1, ['gone_at_2']);
    const worker = join(base, 'migrate-worker.ts');
    writeFileSync(
      worker,
      `
import { openSqlite } from ${JSON.stringify(join(import.meta.dir, 'sqlite-open.ts'))};
const db = openSqlite({
  path: process.argv[2],
  schemaVersion: 2,
  ensureSchema: (d) => d.exec('CREATE TABLE IF NOT EXISTS kept (id INTEGER PRIMARY KEY)'),
  migrations: [{ from: 1, to: 2, apply: (d) => d.exec('DROP TABLE IF EXISTS gone_at_2') }],
});
process.stdout.write(String((db.query('PRAGMA user_version').get()).user_version));
db.close();
`,
    );
    const runs = await Promise.allSettled(
      [0, 1].map(async () => {
        const proc = Bun.spawn(['bun', 'run', worker, path], { stdout: 'pipe', stderr: 'pipe' });
        return {
          out: await new Response(proc.stdout).text(),
          err: await new Response(proc.stderr).text(),
          code: await proc.exited,
        };
      }),
    );
    for (const run of runs) {
      expect(run.status).toBe('fulfilled');
      if (run.status !== 'fulfilled') continue;
      expect(run.value.code, run.value.err).toBe(0);
      expect(run.value.out).toBe('2');
    }
    expect(userVersion(path)).toBe(2);
    expect(tables(path)).toEqual(['kept']);
  }, 30_000);

  test('`migrate: false` declines with PendingMigrationError and changes nothing', () => {
    const path = seed('decline.db', 1, ['gone_at_2']);
    let applied = 0;
    let backups = 0;
    try {
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        migrate: false,
        beforeMigrate: () => {
          backups++;
          return undefined;
        },
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              applied++;
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      });
      throw new Error('expected PendingMigrationError');
    } catch (error) {
      expect(error).toBeInstanceOf(PendingMigrationError);
      expect((error as PendingMigrationError).foundVersion).toBe(1);
      expect((error as PendingMigrationError).expectedVersion).toBe(2);
      expect((error as Error).message).toContain('after taking a backup');
    }
    // Declined means declined: no step, no backup hook, no version change.
    expect(applied).toBe(0);
    expect(backups).toBe(0);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('`migrate: false` on a database the ladder could NOT bridge still throws ForeignDbError', () => {
    // A foreign file is not a pending migration, whoever is asking.
    const path = seed('decline-foreign.db', 5);
    expect(() => openSqlite({ path, schemaVersion: 2, ensureSchema, migrate: false })).toThrow(ForeignDbError);
  });

  test('`beforeMigrate` runs once, before any step, and a throw there aborts untouched', () => {
    const path = seed('hook.db', 1, ['gone_at_2']);
    const order: string[] = [];
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        beforeMigrate: () => {
          order.push('backup');
          throw new Error('backup target is read-only');
        },
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              order.push('step');
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      }),
    ).toThrow('backup target is read-only');
    expect(order).toEqual(['backup']);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('the newer-build refusal carries the exact documented sentence', () => {
    // The docs quote this string verbatim; an operator greps for it. A v2
    // database opened by a build that expects v1 is the shape that will be hit
    // in the field, because a v6 binary migrates and a 5.x one then meets it.
    const path = seed('newer-exact.db', 2);
    try {
      openSqlite({ path, schemaVersion: 1, ensureSchema });
      throw new Error('expected ForeignDbError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignDbError);
      expect((error as Error).message).toContain(
        'written by a newer genie (schema v2); run `genie update` in this checkout',
      );
    }
    expect(userVersion(path)).toBe(2);
  });

  test('a database from a NEWER build names the remedy, not "unrecognized"', () => {
    const path = seed('newer.db', 9);
    try {
      openSqlite({ path, schemaVersion: 2, ensureSchema });
      throw new Error('expected ForeignDbError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignDbError);
      const message = (error as Error).message;
      expect(message).toContain('written by a newer genie (schema v9)');
      expect(message).toContain('`genie update`');
      expect(message).not.toContain('unrecognized schema version');
    }
  });
});
