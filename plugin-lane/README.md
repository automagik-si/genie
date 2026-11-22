# Genie's plugin lane

genie-dsh and the Genie board reach the Automagik desktop app without a Genie CLI release or an
Automagik one. The shape is Automagik's lane, schemaVersion 1 (automagik-si/automagik
`plugin-lane/README.md`), with `publisher: "genie"`:

- https://raw.githubusercontent.com/automagik-si/genie/lane/lane.json
- https://raw.githubusercontent.com/automagik-si/genie/lane/lane.json.sig

- The `lane` branch holds those two files only, a new commit on every publish. Unlike
  Automagik's, Genie's lane is not a rolling release: this repository's releases are
  immutable, so a published release takes no new files. The signature is what a consumer
  trusts, wherever the bytes come from.
- Each tarball stays on its own immutable release: `genie-dsh-v<version>` for
  `@automagik/genie-dsh`, `genie-dsh-board-v<version>` for `@automagik/genie-dsh-board`.
- `lane.json.sig` is ed25519 over the exact bytes of `lane.json`, detached, base64.
  `keys.json` here lists the public keys, `{ keys: [{ keyId, publicKey }] }`, PEM (SPKI).
- A lane that names one plugin keeps that plugin's version as its own: the genie-dsh-only lane
  was genie-dsh's version, and `sequence` is that M.m.p as M·10⁸ + m·10⁴ + p. A lane that names
  both packages cannot borrow either version — the two axes are independent, so a change to the
  lower one would keep the version — and carries the lane's own line instead: `1.0.0` on its
  first publish, the next patch on every publish whose tarballs changed, the minor rolled over
  at the 9999 patch ceiling. A re-run of an unchanged lane keeps the published version, and a
  lane whose sequence would not move forward is refused.
- `base` is the highest `@automagik/bots-dsh` floor the named plugins declare: the oldest Bot
  team release they run on. genie-dsh does not follow Automagik's 3.N lines; the board declares
  no Bot team peer, so it adds no floor.
- The board's `package.json` version is its own line (0.1.0, bumped by the change that moves
  the board), independent of Genie's release version; the release payload's copy keeps the
  Genie release version `scripts/build-binary.sh` stamps on it. genie-dsh keeps its own versions.
- The lane names `@automagik/genie-dsh` and `@automagik/genie-dsh-board` and nothing else.

`.github/workflows/plugin-lane.yml` publishes it when a change to either package lands on dev:
`scripts/plugin-lane.ts` packs, writes, signs and verifies. A released version's tarball is
reused only while its package tree is unchanged since that release's target commit, so a board
change without a version bump fails instead of being re-signed silently. The signing key is the
`PLUGIN_LANE_KEY` Actions secret and exists only there.
