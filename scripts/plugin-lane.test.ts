import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  KEY_ID,
  type Lane,
  PLUGIN_DIR,
  type Packed,
  ROOT,
  baseOf,
  describe as describeTarball,
  manifest,
  pack,
  sequenceOf,
  signLane,
  verifyLane,
} from './plugin-lane';

const PACKED: Packed = {
  name: '@automagik/genie-dsh',
  version: '0.1.2',
  file: 'automagik-genie-dsh-0.1.2.tgz',
  integrity: 'sha512-abc',
  sha256: 'f'.repeat(64),
  size: 10302,
  dsh: '>=0.2.1-rc.2 <0.3.0',
  base: '3.3.0',
};
const COMMIT = 'a'.repeat(40);
const REPOSITORY = 'https://github.com/automagik-si/genie';
const ISSUED_AT = '2026-11-18T00:00:00Z';

/** The board as the lane packs it: its own 0.1.x line and no @automagik/bots-dsh peer. */
const BOARD: Packed = {
  name: '@automagik/genie-dsh-board',
  version: '0.1.0',
  file: 'automagik-genie-dsh-board-0.1.0.tgz',
  integrity: 'sha512-board',
  sha256: 'b'.repeat(64),
  size: 4242,
  dsh: '>=0.1.2-rc.1 <0.3.0-0',
};
const DSH_ENTRY = {
  name: PACKED.name,
  version: PACKED.version,
  url: `${REPOSITORY}/releases/download/genie-dsh-v${PACKED.version}/${PACKED.file}`,
  integrity: PACKED.integrity,
  sha256: PACKED.sha256,
  size: PACKED.size,
  engines: { dsh: PACKED.dsh },
};
const BOARD_ENTRY = {
  name: BOARD.name,
  version: BOARD.version,
  url: `${REPOSITORY}/releases/download/genie-dsh-board-v${BOARD.version}/${BOARD.file}`,
  integrity: BOARD.integrity,
  sha256: BOARD.sha256,
  size: BOARD.size,
  engines: { dsh: BOARD.dsh },
};

/** The lane already published on the lane branch, as the workflow hands it to `manifest`. */
function previousLane(
  version: string,
  plugins: Lane['plugins'] = [DSH_ENTRY, BOARD_ENTRY],
  sequence = sequenceOf(version),
): Lane {
  return {
    schemaVersion: 1,
    publisher: 'genie',
    keyId: KEY_ID,
    sequence,
    issuedAt: ISSUED_AT,
    repository: REPOSITORY,
    version,
    commit: COMMIT,
    base: '3.3.0',
    plugins,
  };
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keys: [{ keyId: KEY_ID, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
}

type YamlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LANE_WORKFLOW = join(ROOT, '.github/workflows/plugin-lane.yml');

function laneWorkflow(): YamlRecord {
  const parsed = Bun.YAML.parse(readFileSync(LANE_WORKFLOW, 'utf8')) as unknown;
  if (!isRecord(parsed)) throw new Error('plugin-lane.yml did not parse as a YAML mapping');
  return parsed;
}

function laneJob(id: string): YamlRecord {
  const jobs = laneWorkflow().jobs;
  if (!isRecord(jobs)) throw new Error('plugin-lane.yml has no jobs mapping');
  const definition = jobs[id];
  if (!isRecord(definition)) throw new Error(`plugin-lane.yml has no "${id}" job`);
  return definition;
}

function jobRuns(job: YamlRecord): string {
  if (!Array.isArray(job.steps)) return '';
  return job.steps
    .filter(isRecord)
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
}

function jobUses(job: YamlRecord): string[] {
  if (!Array.isArray(job.steps)) return [];
  return job.steps.flatMap((step) => (isRecord(step) && typeof step.uses === 'string' ? [step.uses] : []));
}

describe('plugin lane', () => {
  test('sequence grows with every version, so an older lane is refused', () => {
    expect(sequenceOf('0.1.2')).toBe(10_002);
    expect(sequenceOf('0.2.0')).toBeGreaterThan(sequenceOf('0.1.9999'));
    expect(sequenceOf('1.0.0')).toBeGreaterThan(sequenceOf('0.9999.9999'));
    expect(() => sequenceOf('0.1.2-rc.1')).toThrow('not a release version');
  });

  test('base is the floor of the Bot team peer range, and a range without one is refused', () => {
    expect(baseOf('>=3.3.0')).toBe('3.3.0');
    expect(baseOf('>= 3.24.0 <4')).toBe('3.24.0');
    expect(() => baseOf('^3.3.0')).toThrow('no >= floor');
    expect(() => baseOf(undefined)).toThrow('no >= floor');
  });

  test("the manifest is Automagik's schema 1, publisher genie, the tarball on its own versioned release", () => {
    const lane = manifest(PACKED, { commit: COMMIT, issuedAt: '2026-10-26T04:00:00Z' });
    expect(lane).toMatchObject({
      schemaVersion: 1,
      publisher: 'genie',
      keyId: KEY_ID,
      sequence: 10_002,
      version: '0.1.2',
      commit: COMMIT,
      base: '3.3.0',
    });
    expect(lane.plugins).toEqual([
      {
        name: '@automagik/genie-dsh',
        version: '0.1.2',
        url: 'https://github.com/automagik-si/genie/releases/download/genie-dsh-v0.1.2/automagik-genie-dsh-0.1.2.tgz',
        integrity: 'sha512-abc',
        sha256: 'f'.repeat(64),
        size: 10302,
        engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
      },
    ]);
    expect(() => manifest(PACKED, { commit: 'HEAD', issuedAt: 'x' })).toThrow('not a commit');
  });

  test('a signed lane verifies, and a changed byte, another key or another publisher does not', () => {
    const { privatePem, keys } = keyPair();
    const bytes = Buffer.from(JSON.stringify(manifest(PACKED, { commit: COMMIT, issuedAt: '2026-10-26T04:00:00Z' })));
    const signature = signLane(bytes, privatePem);
    expect(verifyLane(bytes, `${signature}\n`, keys).version).toBe('0.1.2');
    const tampered = Buffer.from(bytes.toString().replace('0.1.2', '0.1.3'));
    expect(() => verifyLane(tampered, signature, keys)).toThrow('signature does not match');
    expect(() => verifyLane(bytes, signature, keyPair().keys)).toThrow('signature does not match');
    expect(() => verifyLane(bytes, signature, [{ ...keys[0], keyId: 'other' }] as typeof keys)).toThrow(
      'no key genie-2026-10',
    );
    const automagik = Buffer.from(bytes.toString().replace('"publisher":"genie"', '"publisher":"automagik"'));
    expect(() => verifyLane(automagik, signLane(automagik, privatePem), keys)).toThrow('publisher automagik');
  });

  test('plugin-lane/keys.json lists the key the lane is signed with, as an ed25519 SPKI PEM', () => {
    const { keys } = JSON.parse(readFileSync(join(ROOT, 'plugin-lane', 'keys.json'), 'utf8'));
    const key = keys.find((entry: { keyId: string }) => entry.keyId === KEY_ID);
    expect(key).toBeDefined();
    expect(createPublicKey(key.publicKey).asymmetricKeyType).toBe('ed25519');
  });

  test('the real genie-dsh packs, and a released tarball is described from its own bytes as npm did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-lane-'));
    try {
      const packed = pack(dir);
      const version = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version;
      expect(packed).toMatchObject({
        name: '@automagik/genie-dsh',
        version,
        file: `automagik-genie-dsh-${version}.tgz`,
      });
      expect(packed.integrity).toStartWith('sha512-');
      expect(describeTarball(join(dir, packed.file))).toEqual(packed);
      // The workflow passes a folder relative to the checkout root; npm packs from the plugin's.
      rmSync(join(dir, packed.file));
      expect(pack(relative(process.cwd(), dir))).toEqual(packed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real board packs self-contained, with its own version and no Bot team base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-lane-board-'));
    try {
      const packed = pack(dir, 'genie-dsh-board');
      const pkg = JSON.parse(readFileSync(join(ROOT, 'plugins/dsh-genie-board/package.json'), 'utf8'));
      expect(packed).toMatchObject({
        id: 'genie-dsh-board',
        name: '@automagik/genie-dsh-board',
        version: pkg.version,
        file: `automagik-genie-dsh-board-${pkg.version}.tgz`,
        dsh: pkg.engines.dsh,
      });
      // The board declares no @automagik/bots-dsh peer, so the lane has no base from it.
      expect(packed.base).toBeUndefined();
      expect(describeTarball(join(dir, packed.file))).toEqual(packed);

      const tarball = join(dir, packed.file);
      const members = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n').sort();
      for (const member of [
        'package/NOTICE',
        'package/README.md',
        'package/agent.cordis.yml',
        'package/cordis.patch.yml',
        'package/dist/board.js',
        'package/dist/client.js',
        'package/dist/index.js',
        'package/dist/workflows.js',
        'package/package.json',
      ])
        expect(members).toContain(member);

      // The welcome installer matches each tarball against the entry: the packed package holds the
      // published version, and the lane entry names the same bytes.
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
      );
      expect(manifest.version).toBe(packed.version);
      expect(manifest.minimumGenieVersion).toBe(pkg.minimumGenieVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a two-plugin lane names both packages, each on its own release, on the lane line 1.0.0', () => {
    const lane = manifest([BOARD, PACKED], { commit: COMMIT, issuedAt: ISSUED_AT });
    expect(lane).toMatchObject({
      schemaVersion: 1,
      publisher: 'genie',
      keyId: KEY_ID,
      version: '1.0.0',
      sequence: 100_000_000,
      commit: COMMIT,
      base: '3.3.0',
    });
    // Registry order, so the signed bytes never depend on the caller's order.
    expect(lane.plugins).toEqual([DSH_ENTRY, BOARD_ENTRY]);
  });

  test('the first two-plugin lane starts the lane line forward of the genie-dsh-derived 0.2.2', () => {
    const old = previousLane('0.2.2', [DSH_ENTRY], 20_002);
    const lane = manifest([PACKED, BOARD], { commit: COMMIT, issuedAt: ISSUED_AT, previous: old });
    expect(lane.version).toBe('1.0.0');
    expect(lane.sequence).toBe(100_000_000);
    expect(lane.sequence).toBeGreaterThan(old.sequence);
  });

  test('a changed entry always moves the lane version, and an identical re-sign keeps it', () => {
    const first = manifest([PACKED, BOARD], { commit: COMMIT, issuedAt: ISSUED_AT });
    const again = manifest([PACKED, BOARD], { commit: COMMIT, issuedAt: ISSUED_AT, previous: first });
    expect(again.version).toBe('1.0.0');
    expect(again.sequence).toBe(first.sequence);

    const boardChanged = manifest(
      [PACKED, { ...BOARD, version: '0.1.1', file: 'automagik-genie-dsh-board-0.1.1.tgz' }],
      {
        commit: COMMIT,
        issuedAt: ISSUED_AT,
        previous: again,
      },
    );
    expect(boardChanged.version).toBe('1.0.1');
    expect(boardChanged.sequence).toBe(sequenceOf('1.0.1'));

    const dshChanged = manifest([{ ...PACKED, version: '0.1.3', file: 'automagik-genie-dsh-0.1.3.tgz' }, BOARD], {
      commit: COMMIT,
      issuedAt: ISSUED_AT,
      previous: boardChanged,
    });
    expect(dshChanged.version).toBe('1.0.2');
    expect(dshChanged.sequence).toBeGreaterThan(boardChanged.sequence);
    expect(dshChanged.plugins[0]?.url).toContain('genie-dsh-v0.1.3');
  });

  test('the lane version rolls over at the 4-digit patch ceiling instead of overflowing', () => {
    const previous = previousLane('1.0.9999');
    const lane = manifest([PACKED, { ...BOARD, version: '0.1.1', file: 'automagik-genie-dsh-board-0.1.1.tgz' }], {
      commit: COMMIT,
      issuedAt: ISSUED_AT,
      previous,
    });
    expect(lane.version).toBe('1.1.0');
    expect(lane.sequence).toBe(sequenceOf('1.1.0'));
    expect(lane.sequence).toBeGreaterThan(previous.sequence);
  });

  test('a lane whose sequence would not move forward is refused', () => {
    // A lane whose sequence field is ahead of its own version (an older or hand-edited lane) cannot
    // be continued without publishing a sequence the consumer would refuse.
    const previous = previousLane('1.0.5', [DSH_ENTRY, BOARD_ENTRY], 200_000_000);
    expect(() =>
      manifest([PACKED, { ...BOARD, version: '0.1.1', file: 'automagik-genie-dsh-board-0.1.1.tgz' }], {
        commit: COMMIT,
        issuedAt: ISSUED_AT,
        previous,
      }),
    ).toThrow('would not move forward');
  });

  test('a previous lane is trusted only once its signature verifies against the lane key', async () => {
    const lane = await import('./plugin-lane');
    const { privatePem, keys } = keyPair();
    const dir = mkdtempSync(join(tmpdir(), 'plugin-lane-previous-'));
    try {
      const bytes = Buffer.from(JSON.stringify(previousLane('1.0.0')));
      writeFileSync(join(dir, 'lane.json'), bytes);
      writeFileSync(join(dir, 'lane.json.sig'), `${signLane(bytes, privatePem)}\n`);
      expect(lane.readPreviousLane(dir, keys).version).toBe('1.0.0');

      writeFileSync(join(dir, 'lane.json'), bytes.toString().replace('"version":"1.0.0"', '"version":"1.0.1"'));
      expect(() => lane.readPreviousLane(dir, keys)).toThrow('signature does not match');
      // Another key does not stand for this lane either.
      writeFileSync(join(dir, 'lane.json'), bytes);
      expect(() => lane.readPreviousLane(dir, keyPair().keys)).toThrow('signature does not match');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a lane branch without a readable, signed lane fails instead of minting a fresh lane', async () => {
    const lane = await import('./plugin-lane');
    const { keys } = keyPair();
    const dir = mkdtempSync(join(tmpdir(), 'plugin-lane-missing-'));
    try {
      expect(() => lane.readPreviousLane(dir, keys)).toThrow('no readable lane.json');
      writeFileSync(join(dir, 'lane.json'), JSON.stringify(previousLane('1.0.0')));
      expect(() => lane.readPreviousLane(dir, keys)).toThrow('no readable lane.json.sig');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the lane workflow packs without a token and publishes without installing or building', () => {
    const workflow = laneWorkflow();
    const pack = laneJob('pack');
    const publish = laneJob('publish');

    // The workflow grants nothing by default; each job states its own token.
    expect(workflow.permissions).toEqual({});
    expect(pack.permissions).toEqual({ contents: 'read' });
    expect(publish.permissions).toEqual({ contents: 'write' });
    expect(publish.needs).toBe('pack');

    // Packing runs the board's prepare build, so it holds no secret and produces the bytes.
    expect(JSON.stringify(pack)).not.toContain('secrets.');
    expect(jobRuns(pack)).toContain('bun install --frozen-lockfile --ignore-scripts');
    expect(jobRuns(pack)).toContain('plugin-lane.ts pack dist genie-dsh');
    expect(jobRuns(pack)).toContain('plugin-lane.ts pack dist genie-dsh-board');
    expect(jobUses(pack).some((uses) => uses.startsWith('actions/upload-artifact@'))).toBe(true);

    // Publishing holds the write token and the key: it installs nothing and builds nothing.
    expect(JSON.stringify(publish)).toContain('secrets.PLUGIN_LANE_KEY');
    expect(jobRuns(publish)).not.toContain('bun install');
    expect(jobRuns(publish)).not.toContain('npm ');
    expect(jobRuns(publish)).not.toContain('pack dist');
    expect(jobUses(publish).some((uses) => uses.startsWith('actions/download-artifact@'))).toBe(true);

    // Every action is pinned to a full commit sha.
    for (const uses of [...jobUses(pack), ...jobUses(publish)]) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });

  test('the workflow names both packages and hands publish a verified previous lane', () => {
    const workflow = readFileSync(LANE_WORKFLOW, 'utf8');
    expect(workflow).toContain("'plugins/dsh-genie-board/**'");
    expect(workflow).toContain("'plugins/genie-dsh/**'");
    expect(workflow).not.toContain('dsh-workflow-loader');
    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('genie-dsh-board-v');
    // The lane branch's checkout is the only previous lane the manifest is handed, and it verifies it.
    expect(workflow).toContain('previous=lane');
    expect(workflow).toContain('args+=("${PREVIOUS}")');
    expect(workflow).toContain('git diff --quiet');
    expect(workflow).toContain('bump plugins/dsh-genie-board/package.json version');
  });
});
