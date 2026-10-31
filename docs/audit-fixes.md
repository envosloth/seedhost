# Audit fixes (2026-10-31)

Remediation of the six findings in `SeedHost-full-code-audit-2026-10-31.md`. Each item below is covered by a
regression test that fails on the audited commit `5990e33` and passes here.

## 1. Replay-safe relay retention (F1)

`RelayNode.recordParkedRevision` runs under the same cross-process lock as acceptance, claim preparation and
revocation, and keeps two invariants:

- the revision the custody ledger holds **now** is always in the prune keep-set, whatever an older retention cycle
  recorded;
- an accepted **replay** of an already-accepted offer is an acknowledgment only — it never re-enters
  `relay.json`'s rolling history, so it cannot promote an old revision over the current one.

Consequence to know: pruning now happens while the relay's mutation lock is held. Parks and claims queue behind it on a
large store. That is deliberate — a stale keep-set is exactly what destroyed the authoritative revision.

Not changed: a legacy `offered` record without completion evidence still cannot be force-cleared.

## 2. One effective Minecraft port (F2)

`effectiveServerPort()` in `server-properties.ts` is the single Java-compatible reader (last key wins, `:`/whitespace
separators, escaped keys). `readServerPort()` now uses it, so public-tunnel reservations, Start admission, library
summaries and status probes all see the port the JVM actually binds. Launch preflight still refuses a malformed port
outright instead of guessing.

## 3. Desktop runtime and tooling (F3)

- Electron `^44.10.1`: patched 44.x line for GHSA-jr5w-w6x2-84p9 **and** it embeds Undici `7.30.1`, so the
  excessive-content-encoding crash (GHSA-xjj6-f33q-929c) no longer terminates the process. Verified against the real
  binary, not the npm manifest.
- `overrides` pin `glob ^14.0.3`, `minimatch ^11.0.3` and `undici ^7.30.1`, which clears the advisory chain under
  `@electron/packager` without downgrading the packager.
- `npm audit` reports 0 vulnerabilities for this tree. This is a lockfile statement, not a proof of runtime safety.

## 4. State capacity (F4)

`MAX_LIBRARY_SERVERS` and `MAX_PENDING_GROUPS` live in `saved-state.ts` and are shared by the parser and by
`SeedHostApplication.assertCapacity()`. Create, import, claim and group-join refuse **before** copying files or
redeeming an invitation. `persist()` also refuses to write an out-of-range state, so no path can save a profile that
`open()` rejects.

Existing oversized profiles are untouched: `open()` still fails closed with the original message and the file is never
rewritten.

## 5. ZIP writes (F5)

`writeZip` advances by `bytesWritten` and loops, and fails on a zero-progress write. A zero-progress write leaves no
published archive; the destination is only created by the final rename of the flushed temporary.

## 6. Java runtime download cleanup (F6)

The six runtime download workers share one `AbortController` derived from the operation signal. The first failure
cancels the rest, every worker is awaited, and only then does the catch block delete staging. `writeFile`/`mkdir` are
guarded by an abort check so a worker cannot recreate the directory.

## Verification

- Focused new tests: relay replay retention (keep 1 and keep 10), port agreement + public reservation guard, ZIP
  success/short-write/stalled-write, runtime worker drain, library and pending-group capacity.
- Canonical gate: recorded in the release evidence for this branch. Re-run `npm test` after any further change.

## Still open (not fixed here)

- `tools/package-release.mjs` still selects the newest `release/alpha-*` folder by modification time and labels the ZIP
  with the working tree's version. Bind it to an explicit verified package manifest before publishing.
- `tools/publish-release.mjs` still creates the public release before uploading assets and deletes an existing asset
  before its replacement succeeds. Prepare a draft, verify both assets, then publish.
- Native power-loss durability of snapshot publication and the update apply step are not certified by these tests.

## Operational note

This tree has its own `node_modules` (the other worktrees share one junction). The Electron binary is fetched by
`node node_modules/electron/install.js` when npm's postinstall is gated; without it the packaged app has no runtime.
