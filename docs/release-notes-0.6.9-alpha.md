# SeedHost 0.6.9-alpha

Unsigned portable Windows alpha. **Update the group relay and every participating hosting PC together** before using
Multi-host Start: an older relay does not enforce the durable checkout fence, and an older host does not read the
replay-safe retention rules. Keep independent world backups.

This release is the fix set from the 2026-10-31 code audit, plus the earlier failed-checkout recovery work. It does not
install anything, migrate a live world, or repair a historical pending checkout.

## Group hosting reliability

- **Retention can no longer delete the world the relay is holding.** Retrying an already-accepted handoff used to move
  the *old* revision back into the retention set, so cleanup could prune the current one: the group still showed a
  pending checkout while the next claim failed because the data was gone. A retry is now an acknowledgment only, the
  current revision is always kept, and retention runs under the same lock as acceptance.
- **A failed claim no longer strands the group.** If a PC runs out of disk before accepting ownership, the relay
  provably releases the reservation instead of leaving the group locked to that PC forever. Installation-volume checks
  now include the working copy, and a failure before authority returns a definitive decline while the member keeps
  their previous world.
- Group-owner Start and member removal can recover an abandoned pre-complete checkout after a restart; stale transfer
  streams cannot then authorize ownership. Lost acknowledgments and legacy records stay fenced — this is not a
  force-unlock.

## Safety fixes

- **The Minecraft port guard sees the real port.** `server-port` is read with the same Java-properties rules as launch
  preflight (repeat keys, `:`/whitespace separators, escaped keys), so a public-tunnel reservation can no longer protect
  a port the server never binds.
- **A library can no longer save itself into an unopenable state.** Creating, importing, claiming and group-joining
  refuse before passing the size the saved-state format accepts, and saving enforces the same bound.
- **Client-pack exports cannot be reported as complete while truncated.** Short file writes are continued; a write that
  makes no progress fails the export and leaves no archive.
- **A failed Java download stops immediately.** Remaining runtime download workers are cancelled and drained before the
  download folder is removed, so nothing keeps writing (or filling a small disk) after setup reported failure.

## Runtime and build

- Desktop runtime is now Electron 44.10.1, which carries the compromised-intermediate-certificate mitigation and
  embeds Undici 7.30.1 (fixes a remote crash on malformed compressed responses).
- Build tooling pins patched `glob`, `minimatch` and `undici`; `npm audit` is clean for this tree.

## Known limits

- A legacy pending checkout created before this release (for example the historical `jyzputin` record) is still not
  auto-cleared. Unknown acceptance is not permission to host; recovery stays evidence-bound.
- Retention now prunes while holding the relay's mutation lock, so on a very large store a park or claim can wait
  behind cleanup.
- Public-provider allocation, different-network handover and authenticated Minecraft gameplay are not certified by the
  automated process/socket tests.

Full audit and remediation evidence: `docs/audit-fixes.md`.
