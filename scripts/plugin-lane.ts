#!/usr/bin/env bun
/**
 * Genie's plugin lane: genie-dsh and the Genie board reach the Automagik desktop app (and any
 * market that reads lanes) without a Genie CLI release or an Automagik one. The shape is
 * Automagik's (automagik-si/automagik plugin-lane/README.md, schemaVersion 1): one signed
 * manifest on the `lane` branch of this repository, each tarball on its own immutable release.
 * Not on a rolling release as Automagik's is: this repository's releases are immutable, so a
 * published one takes no new files.
 *
 *   https://raw.githubusercontent.com/automagik-si/genie/lane/lane.json
 *   https://raw.githubusercontent.com/automagik-si/genie/lane/lane.json.sig
 *
 * The signature is ed25519 over the exact bytes of lane.json, detached, base64; the public
 * keys are plugin-lane/keys.json, and the private key exists only as the PLUGIN_LANE_KEY
 * Actions secret. .github/workflows/plugin-lane.yml runs each step:
 *
 *   bun scripts/plugin-lane.ts pack <dir> [plugin]                 npm pack one plugin into dir; print its entry
 *   bun scripts/plugin-lane.ts describe <tgz>                     the same entry for a tarball already released
 *   bun scripts/plugin-lane.ts manifest <packed.json> <commit> <issuedAt> [lane-dir]   print lane.json
 *   bun scripts/plugin-lane.ts sign <lane.json>                    print its signature (PLUGIN_LANE_KEY, PEM)
 *   bun scripts/plugin-lane.ts verify <lane.json> <lane.json.sig>  check it against plugin-lane/keys.json
 */
// Every import is a node builtin on purpose: .github/workflows/plugin-lane.yml's publish job
// (contents: write, the PLUGIN_LANE_KEY secret) runs this file without installing or building
// anything, and a package import here would make that job fetch and execute third-party code.
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const SCHEMA_VERSION = 1;
export const PUBLISHER = 'genie';
export const KEY_ID = 'genie-2026-10';
export const REPOSITORY = 'https://github.com/automagik-si/genie';

/** One package the lane publishes: where it lives, what npm calls its tarball, its release tag. */
export interface PluginSpec {
  id: PluginId;
  name: string;
  dir: string;
  tarballPrefix: string;
  releasePrefix: string;
}
export type PluginId = 'genie-dsh' | 'genie-dsh-board';

const GENIE_DSH: PluginSpec = {
  id: 'genie-dsh',
  name: '@automagik/genie-dsh',
  dir: join(ROOT, 'plugins', 'genie-dsh'),
  tarballPrefix: 'automagik-genie-dsh-',
  releasePrefix: 'genie-dsh-v',
};
const GENIE_DSH_BOARD: PluginSpec = {
  id: 'genie-dsh-board',
  name: '@automagik/genie-dsh-board',
  dir: join(ROOT, 'plugins', 'dsh-genie-board'),
  tarballPrefix: 'automagik-genie-dsh-board-',
  releasePrefix: 'genie-dsh-board-v',
};
export const PLUGINS: readonly PluginSpec[] = [GENIE_DSH, GENIE_DSH_BOARD];
/** The genie-dsh package, the lane's original member. */
export const PLUGIN_DIR = GENIE_DSH.dir;

/** A tarball name matches the longest prefix first: the board's starts with genie-dsh's. */
const BY_LONGEST_PREFIX = [...PLUGINS].sort((a, b) => b.tarballPrefix.length - a.tarballPrefix.length);

/** What `pack` writes: the tarball npm made, and what describes its bytes. */
export interface Packed {
  /** The plugin that produced the tarball; manifest falls back to the package name. */
  id?: PluginId;
  name: string;
  version: string;
  file: string;
  integrity: string;
  sha256: string;
  size: number;
  /** The plugin's own DSH range (package.json engines.dsh). */
  dsh: string;
  /** The lowest Bot team release the plugin runs on (its @automagik/bots-dsh peer range). */
  base?: string;
}

export interface Lane {
  schemaVersion: number;
  publisher: typeof PUBLISHER;
  keyId: string;
  sequence: number;
  issuedAt: string;
  repository: string;
  version: string;
  commit: string;
  base: string;
  plugins: {
    name: string;
    version: string;
    url: string;
    integrity: string;
    sha256: string;
    size: number;
    engines: { dsh: string };
  }[];
}

export interface LaneKey {
  keyId: string;
  publicKey: string;
}

export interface ManifestOptions {
  commit: string;
  issuedAt: string;
  /** The lane already on the lane branch, verified by `readPreviousLane`; it orders the next lane. */
  previous?: Lane;
}

/** A version's place in the lane's order, so a consumer refuses an older lane: M.m.p as M·10⁸ + m·10⁴ + p. */
export function sequenceOf(version: string): number {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(version);
  if (!match) throw new Error(`not a release version: ${version}`);
  return Number(match[1]) * 100_000_000 + Number(match[2]) * 10_000 + Number(match[3]);
}

/** The floor of a `>=x.y.z` peer range: the Bot team release the plugin was built against. */
export function baseOf(peerRange: string | undefined): string {
  const match = /^>=\s*(\d+\.\d+\.\d+)/.exec(peerRange ?? '');
  if (!match?.[1]) throw new Error(`@automagik/bots-dsh peer range has no >= floor: ${peerRange}`);
  return match[1];
}

function pluginOf(id: string): PluginSpec {
  const spec = PLUGINS.find((plugin) => plugin.id === id);
  if (!spec) throw new Error(`lane: unknown plugin ${id} (expected ${PLUGINS.map((plugin) => plugin.id).join(' | ')})`);
  return spec;
}

function specOf(packed: Packed): PluginSpec {
  const spec = PLUGINS.find((plugin) => plugin.id === packed.id || plugin.name === packed.name);
  if (!spec) throw new Error(`lane: ${packed.name} is not one of the lane's plugins`);
  return spec;
}

/** Describe a plugin's tarball from its own bytes, with the range fields the checkout declares. */
export function describe(file: string, plugin?: PluginId): Packed {
  const spec = plugin
    ? pluginOf(plugin)
    : (BY_LONGEST_PREFIX.find(
        (candidate) => basename(file).startsWith(candidate.tarballPrefix) && basename(file).endsWith('.tgz'),
      ) ?? null);
  if (!spec) throw new Error(`lane: no plugin packs ${basename(file)}`);
  const pkg = JSON.parse(readFileSync(join(spec.dir, 'package.json'), 'utf8'));
  if (!pkg.engines?.dsh) throw new Error(`${spec.id} declares no engines.dsh`);
  const name = basename(file);
  const version = name.slice(spec.tarballPrefix.length, -'.tgz'.length);
  if (version !== pkg.version) throw new Error(`${name} is not ${spec.id} ${pkg.version}`);
  const bytes = readFileSync(file);
  const peer = pkg.peerDependencies?.['@automagik/bots-dsh'];
  return {
    id: spec.id,
    name: pkg.name,
    version,
    file: name,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    dsh: pkg.engines.dsh,
    base: peer === undefined ? undefined : baseOf(peer),
  };
}

/** npm pack one plugin into `dir` (relative to the caller's folder, not the plugin's) and describe the tarball. */
export function pack(dir: string, plugin: PluginId = 'genie-dsh'): Packed {
  const spec = pluginOf(plugin);
  const out = resolve(dir);
  const [entry] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd: spec.dir, encoding: 'utf8' }),
  );
  const packed = describe(join(out, entry.filename), plugin);
  if (packed.integrity !== entry.integrity) throw new Error('npm and this script disagree on the tarball integrity');
  return packed;
}

/** The lane already on the lane branch: both files must be there, and the signature must verify. */
export function readPreviousLane(dir: string, keys: LaneKey[] = laneKeys()): Lane {
  const laneFile = join(dir, 'lane.json');
  const signatureFile = join(dir, 'lane.json.sig');
  let bytes: Buffer;
  try {
    bytes = readFileSync(laneFile);
  } catch {
    throw new Error(`lane: the lane branch has no readable lane.json in ${dir}`);
  }
  let signature: string;
  try {
    signature = readFileSync(signatureFile, 'utf8');
  } catch {
    throw new Error(`lane: the lane branch has no readable lane.json.sig in ${dir}`);
  }
  return verifyLane(bytes, signature, keys);
}

function laneKeys(): LaneKey[] {
  return JSON.parse(readFileSync(join(ROOT, 'plugin-lane', 'keys.json'), 'utf8')).keys;
}

export const signLane = (bytes: Buffer, privatePem: string) =>
  signBytes(null, bytes, createPrivateKey(privatePem)).toString('base64');

/** The lane, once its signature checks out against one of `keys` and its schema is known. */
export function verifyLane(bytes: Buffer, signature: string, keys: LaneKey[]): Lane {
  const lane = JSON.parse(bytes.toString('utf8')) as Lane;
  const key = keys.find((entry) => entry.keyId === lane.keyId);
  if (!key) throw new Error(`lane: no key ${lane.keyId}`);
  if (!verifyBytes(null, bytes, createPublicKey(key.publicKey), Buffer.from(signature.trim(), 'base64'))) {
    throw new Error('lane: the signature does not match');
  }
  if (lane.schemaVersion !== SCHEMA_VERSION) throw new Error(`lane: schema ${lane.schemaVersion}`);
  if (lane.publisher !== PUBLISHER) throw new Error(`lane: publisher ${lane.publisher}`);
  return lane;
}

type LanePlugin = Lane['plugins'][number];

function laneEntry(packed: Packed, spec: PluginSpec): LanePlugin {
  return {
    name: packed.name,
    version: packed.version,
    url: `${REPOSITORY}/releases/download/${spec.releasePrefix}${packed.version}/${packed.file}`,
    integrity: packed.integrity,
    sha256: packed.sha256,
    size: packed.size,
    engines: { dsh: packed.dsh },
  };
}

/** A lane's plugins as one order-free key, so a re-sign is recognised only on identical tarballs. */
function entriesKey(plugins: LanePlugin[]): string {
  return plugins
    .map((plugin) =>
      [plugin.name, plugin.version, plugin.url, plugin.integrity, plugin.sha256, plugin.size, plugin.engines.dsh].join(
        '\u0000',
      ),
    )
    .sort()
    .join('\n');
}

/** The highest Bot team floor the named plugins declare, so the lane is taken on any app at or past it. */
function highestBase(bases: string[]): string | undefined {
  const parsed = bases.map((base) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
    if (!match) throw new Error(`lane: not a base version: ${base}`);
    return { base, order: [Number(match[1]), Number(match[2]), Number(match[3])] as const };
  });
  parsed.sort(
    (left, right) => left.order[0] - right.order[0] || left.order[1] - right.order[1] || left.order[2] - right.order[2],
  );
  return parsed[parsed.length - 1]?.base;
}

/**
 * The lane's own version line. A lane that names one plugin takes that plugin's version, as the
 * genie-dsh-only lane always did. A lane that names both packages cannot borrow either version:
 * the two axes are independent, so a change to the lower one would keep the version. It starts
 * at 1.0.0 and moves one patch on every publish whose entries changed, rolling the minor over at
 * the 4-digit patch ceiling sequenceOf accepts. A re-sign of identical entries keeps the version.
 */
function nextLaneVersion(previous: Lane | undefined, identical: boolean): string {
  if (!previous) return '1.0.0';
  if (identical) return previous.version;
  if (Number(previous.version.split('.')[0]) === 0) return '1.0.0';
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(previous.version);
  if (!match) throw new Error(`lane: ${previous.version} is not a lane version`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (patch < 9999) return `${major}.${minor}.${patch + 1}`;
  if (minor < 9999) return `${major}.${minor + 1}.0`;
  if (major < 9999) return `${major + 1}.0.0`;
  throw new Error('lane: the lane version line is exhausted');
}

/** lane.json for the packed plugins, ordered by the lane the branch already published. */
export function manifest(packed: Packed | Packed[], { commit, issuedAt, previous }: ManifestOptions): Lane {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`);
  if (
    previous &&
    (typeof previous.version !== 'string' || !Number.isInteger(previous.sequence) || !Array.isArray(previous.plugins))
  ) {
    throw new Error('lane: the previous lane is not a lane');
  }
  const planned = (Array.isArray(packed) ? packed : [packed]).map((one) => {
    const spec = specOf(one);
    return { spec, base: one.base, entry: laneEntry(one, spec) };
  });
  if (planned.length === 0) throw new Error('lane: the lane names no plugin');
  if (new Set(planned.map(({ spec }) => spec.id)).size !== planned.length) {
    throw new Error('lane: a plugin is named twice');
  }
  // Registry order, so the signed bytes never depend on the caller's order.
  planned.sort((left, right) => PLUGINS.indexOf(left.spec) - PLUGINS.indexOf(right.spec));

  const entries = planned.map(({ entry }) => entry);
  const identical = previous ? entriesKey(previous.plugins) === entriesKey(entries) : false;
  const version = planned.length === 1 ? entries[0].version : nextLaneVersion(previous, identical);
  const base =
    planned.length === 1 ? planned[0].base : highestBase(planned.flatMap(({ base: floor }) => (floor ? [floor] : [])));
  if (!base) throw new Error('lane: the lane needs a @automagik/bots-dsh base');

  const sequence = sequenceOf(version);
  if (previous && (sequence < previous.sequence || (sequence === previous.sequence && !identical))) {
    throw new Error(`lane: sequence ${sequence} would not move forward from ${previous.sequence}`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    publisher: PUBLISHER,
    keyId: KEY_ID,
    sequence,
    issuedAt,
    repository: REPOSITORY,
    version,
    commit,
    base,
    plugins: entries,
  };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const out = (text: string) => process.stdout.write(`${text}\n`);
  if (command === 'pack' && (args.length === 1 || args.length === 2)) {
    const [dir, plugin] = args as [string, PluginId | undefined];
    out(JSON.stringify(pack(dir, plugin), null, 2));
  } else if (command === 'describe' && args.length === 1) {
    out(JSON.stringify(describe(args[0] as string), null, 2));
  } else if (command === 'manifest' && (args.length === 3 || args.length === 4)) {
    const [file, commit, issuedAt, laneDir] = args as [string, string, string, string | undefined];
    // The lane branch's own lane, verified here before its version, sequence or entries are read.
    const previous = laneDir ? readPreviousLane(laneDir) : undefined;
    const packed = JSON.parse(readFileSync(file, 'utf8')) as Packed | Packed[];
    out(JSON.stringify(manifest(packed, { commit, issuedAt, previous }), null, 2));
  } else if (command === 'sign' && args.length === 1) {
    const key = process.env.PLUGIN_LANE_KEY;
    if (!key) throw new Error('PLUGIN_LANE_KEY is not set');
    out(signLane(readFileSync(args[0] as string), key));
  } else if (command === 'verify' && args.length === 2) {
    const lane = verifyLane(readFileSync(args[0] as string), readFileSync(args[1] as string, 'utf8'), laneKeys());
    out(`lane ${lane.version} (sequence ${lane.sequence}) is signed by ${lane.keyId}`);
  } else {
    process.stderr.write(
      'usage: bun scripts/plugin-lane.ts pack <dir> [plugin] | describe <tgz> | manifest <packed.json> <commit> <issuedAt> [lane-dir] | sign <lane.json> | verify <lane.json> <sig>\n',
    );
    process.exit(2);
  }
}
