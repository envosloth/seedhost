# Failed group checkout recovery

## Contract

A failed download must not reserve a hosting group indefinitely when the recipient could not have accepted ownership. Recover only from durable evidence; a timeout or lost acknowledgment does not establish that acceptance failed.

The relay records `checkoutPhase: streaming` and zero `checkoutCompletions` when preparing a new checkout. Immediately before sending `complete`, every current relay sender takes the shared cross-process admission lock, rechecks membership and the exact offer, and durably records an acceptance permission. Only then may a recipient invoke its authority callback.

An interrupted stream with no completion permissions can atomically withdraw its exact offer and restore stopped relay custody. An owner can perform the same evidence-bound recovery after restart. The durable comparison fences delayed senders before their `complete` frame. Owner Start and owner member removal use this recovery; ordinary members are not granted management authority.

A materialization helper runs strictly before any library/ownership activation. It checks working-copy space and converts only failures in that pre-authority installation scope into a definitive decline. The claim wrapper sends the pinned false acknowledgment before reporting the actionable local disk error. Generic callback errors, timeouts and authority-commit failures are not declines.

A false acknowledgment releases only the sole lifetime completion permission for an exact offer. Another or earlier completed stream might still accept, so one decline cannot cancel their authority. Legacy offers with no phase/completion evidence remain unknown, even after an upgrade.

## Regression coverage

`tests/relay.test.ts` covers:

- Low-storage group Start with a different member subsequently starting the same world.
- Cached transfer followed by insufficient space for the installed working copy.
- ENOSPC injected into actual materialized-file writes for a returning member, preserving its previous files and ownership metadata.
- Two independent relay instances sharing one ledger, where one completed stream declines while the other may still accept.
- Owner Start after relay restart and owner member removal of a proven pre-complete checkout.
- Legacy and acceptance-possible refusal for owner recovery, Start and removal; non-owner recovery refusal.
- An independently canceled sender paused before completion, with no subsequent `complete` frame.
- Durable acceptance followed by failure, with all other Starts/removals fenced and exact recipient retry succeeding.
- Existing round-trip, handoff, acknowledgment-loss and retention tests.

## Verification

- Canonical `npm test`: 1,138 tests, 1,137 passed, 0 failed, 0 cancelled, 1 skipped; exit 0. The skipped case is the opt-in live official Vanilla/Fabric preparation requiring real Java/upstream JARs.
- Focused relay/ownership/application-handoff gate: 36 passed; exit 0.
- Regression runner importing the actual local package's bundled core: 10 passed; exit 0.
- Exact package resource-equivalence check: 126 source resources matched.
- Exact packaged executable: visible isolated Electron A-to-B-to-A pinned-TLS handoff, synthetic server Start/Stop, canceled deletion and 90-second inspection hold passed. Only native dialog answers were substituted.
- Independent GPT 6.1 Terra static review found no security or logic issues. This static verdict is separate from the executed gates above.
- RED proofs caught the original low-storage lock, missing install preflight, unsafe concurrent decline, owner recovery failures and misleading error text. Disabling the pre-authority installation helper in a separate counterproof tree reproduced ENOSPC leaving custody offered; restoration passed.

These are isolated loopback/process proofs, not Minecraft gameplay or different-network certification. No live world or ownership record was changed.

## Deployment

This source change is unreleased. The local verification candidate retains its baseline package version; do not confuse it with the published alpha.

Stop old relay processes and update the group relay and participating PCs together before deploying. Older concurrent binaries cannot enforce the new durable completion fence. Existing legacy pending checkout cannot safely be force-cleared just because the new code is installed; reconcile the exact recipient authority or perform an explicitly separate recovery without overwriting the original lineage.
