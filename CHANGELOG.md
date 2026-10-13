# Changelog

## 0.6.8-alpha

Unsigned portable Windows alpha. Update all participating hosting PCs and the group relay before testing. Keep independent world backups; no automatic installation or live-world migration is performed by publishing this release.

- Installed server and client mods appear first and can be filtered without searching the online catalogue. Discovery, compatibility checks and guarded mod operations remain available.
- Quick setup's X and Escape cancel an uncreated server instead of forcing creation. Selecting a setup stage explicitly saves draft progress; an in-flight creation remains guarded.
- Only the hosting-group owner can disband the group. Members can leave with a pinned-relay acknowledgment and durable local readback; failed or uncertain removal is not reported as success.
- The group owner's canonical server name is published through the pinned relay and used when members download the server. Name publication follows local safety checks and confirmed relay reachability.
- Local operator revocation of the appointed owner clears owner-authored metadata in the same durable update, allowing a clean relay restart and explicit replacement-owner appointment without restoring the revoked owner.
- Save backup and successful Stop retain the newest completed ordinary backup automatically. Older ordinary revisions and unused objects are pruned only after the replacement is verified durable. Other worlds, custody references, recovery evidence and conflict branches remain protected; unresolved state defers cleanup, so more than one revision may remain.
- The Multi-host Take over button and generic hosting-authority warning are removed. Group guidance points to ordinary Start server; exclusive ownership, pending-Start and uncertainty fences remain enforced.
- The optional always-on player gateway remains the way to share one persistent group address. Automatic per-server Playit setup still requires the provider's first-time account approval; no account-free provider workflow or portable tunnel credential is added.

Known limits: scheduled backup-only jobs, profile-update backups and old materialized server folders are not covered by automatic revision retention. Ordinary replaced revisions no longer appear as restore choices; protected retained history remains available. Public-provider allocation, different-network handover and authenticated Minecraft gameplay are not certified by the automated process/socket tests.

## 0.6.6-alpha

Unsigned portable Windows alpha. Update both hosting PCs and retain independent world backups.

- Initial group publication now allows up to two minutes for the owner's stopped-world snapshot and park instead of expiring after five seconds. Ordinary control-request deadlines stay unchanged; timeout still does not authorize takeover or launch on uncertain custody.
- Playit status polling no longer reports a missing tunnel while its first creation is still in progress. Saved-route validation resumes only after the tunnel binding is persisted; genuinely missing or changed routes still refuse.
- Real isolated pinned-TLS regressions reproduce both failures and cover delayed publication, bounded expiry without a late launch, concurrent setup polling and changed-route rejection. This is not different-network Minecraft gameplay certification.

## 0.6.5-alpha

Unsigned portable Windows alpha for one-click group hosting. Both hosts should update; keep independent world backups before testing.

- Group **Start server** synchronizes the latest safely saved world, mods, configuration and deletions, then acquires exclusive authority and launches locally. Pending membership creates a new managed server without replacing an unrelated world.
- Active hosts block competing Starts. Concurrent Starts admit one winner. Durable starting reservations fence revocation and handoff races; unreachable or uncertain custody never means idle.
- Group Stop must save and publish before another host can start, even with the legacy park-on-stop option off. Failed publication remains fenced and retryable.
- Explicit group binding consumes only its matching pending membership; Windows setup-progress saves retry transient reader-held atomic replacement failures without deleting the old file.
- Automatic group launch supports validated unambiguous Vanilla/Fabric JAR layouts and approved local Java. Script/argument-file/ambiguous modloader layouts refuse; advanced launch is not a group bypass.
- Crash/restart or lost Start acknowledgment may conservatively strand a pending admission. No automatic expiry, takeover or unsafe recovery was added.
- Real Electron and synthetic Java process/file checks cover latest bytes, deletions, A→B→A rotation, active-host refusal and single-spawn competition. These are not Minecraft gameplay, arbitrary modpack or different-network certification.

## 0.6.4-alpha

Unsigned portable Windows alpha. Includes the previously local 0.6.3-alpha ownership/revocation fixes below; keep independent world backups.

- World-scoped setup-guide progress completes friend actions in place and rejects stale workflow results; the optional always-on role is no longer a guide prerequisite.
- Mods discovery, compatibility options and installed server/client lists are visible together.
- Native download-folder selection supports quiet cancellation, retains the verified source and adopts a separate managed copy. Captured directory identity remains checked through adoption awaits; exclusive configuration creation refuses aliased existing files.
- Routine actions explain consequences inline instead of warning popups. Incoming handoffs require request-scoped inline accept/decline with expiry to refusal; busy-operation and safe-stop quit guards remain. Server deletion retains a Cancel-default confirmation.
- Accessible server cards open by click/Enter/Space, excluding nested copy/delete actions. Unchanged hosting-group cards retain their DOM, focus and opacity through polling.
- Friends labels show each group's associated world or explicit pending/serverless membership. Ordinary friendship grants no world access.
- Server files opens the validated managed OS folder through ID-only privileged IPC.
- Dashboard status shares concurrent probes and bounds sample freshness by world/process/port; unavailable players remain unknown. This reduces duplicate polling, not a measured Minecraft TPS or internet-latency improvement.
- New worlds initiate their own Playit setup using the exact created-world ID and distinct reserved ports. Provider approval, pending allocation and failure remain explicit; local/direct hosting works without a helper or public address.

## 0.6.3-alpha

Local unsigned alpha for this PC, installed beside 0.6.2-alpha. Not published to GitHub.

- Hosting invitations: resending for the same friend and hosting group atomically replaces the pending request (fresh id and endpoint) instead of refusing "An invitation is already waiting"; other groups coexist; exact retries stay idempotent.
- Revocation: removal is serialized on the relay queue and the cross-process lock; a handoff still pending to that device is refused; revoking a settled holder still cuts access (pinned by the gateway suites).
- Park/claim decisions commit under the same cross-process lock as revocation; the first world lineage is established by the configured group owner (ownerless legacy groups keep the previous behavior).
- A damaged ownership record no longer blocks startup or the library: the recovery journal is kept, ownership stays fenced, healthy worlds remain selectable.
- Concurrent group creation reserves the primary helper atomically.
- Tests: the concurrent-junction-replacement regression tolerates the transient Windows EBADF realpath race (reproduced 1/10 on the unmodified baseline); new falsification-tested regressions for the fixes above.

## 0.6.1-alpha

Unsigned portable Windows alpha. Preserve independent world backups.

- Setup-guide progress is isolated per server, with a separate new-server draft and guarded legacy migration.
- Slow foreground actions show accessible loading feedback; background polling stays quiet.
- Cancelling Create, Import, or Java-profile confirmation is quiet rather than reporting a false failure.
- Windows snapshot safety walks retry transient delete-pending children within a bounded budget while persistent denial and unsafe links still fail closed.
- Performance memory displays GiB correctly; friend lists refresh correctly with isolated account fixtures.

Verification of the preceding feature commit: canonical build/test gate 869 passed, 0 failed, 1 skipped; packaged usability check passed. Release-version gate and published-asset validation are recorded with the release notes.

## 0.5.0-alpha — 2026-10-05

**Unsigned portable alpha. Keep your own world backups.** Windows packaging is verified; this release is not Windows runtime or remote-friend gameplay certification.

### Added
- **Accounts and username invitations.** First-use signup, private invitation inboxes, recipient/device-bound invitations and explicit owner-only member removal. Sessions are OS-encrypted on the client and bound to the pinned directory identity. The directory stores account and invitation metadata only, never world files.
- **Cross-network hosting groups.** Both directory and group transport support publicly reachable pinned TLS, including DNS SNI through raw TCP ingress. Configured friends can join without installing Tailscale; the administrator’s always-on PC and connection must remain available. Existing Playit player routing is independent.
- **One-click public address.** A **Let friends join from anywhere** card sits on **My server** with one button, **Get my address**, on any PC. On a gaming PC paired with an always-on PC, the always-on PC makes the address (no browser step when it already has a playit agent, e.g. `seedhost-relay serve --playit-secret <file> --playit-external yes`) and this PC's link to it is switched on too. On the always-on PC itself — or on a PC with no always-on PC yet, which becomes one — Seed Hosting downloads playit.gg's official agent (pinned v1.0.10, SHA-256 checked, no admin rights), opens playit's approval page as the only manual step (a free playit account is required; playit no longer offers guest accounts), runs the agent hidden with crash restarts, and makes or reuses one Minecraft tunnel. The card shows numbered progress, then the address with **Copy**, and says *open to friends* only after a real Minecraft ping through it. The bring-your-own-agent panel is now **Advanced: use your own playit.gg agent**.
- **One-click always-on PC.** The setup guide's Always-on PC step is now two buttons. **This PC stays on** runs the relay and the shared player address inside Seed Hosting itself — no Node.js, terminal or commands — restarts it with the app, and shows a 12-character pairing code. **I play on this PC** takes that code, finds the always-on PC on the network, joins it with the code-derived single-use invitation (certificate pinned via a code-keyed MAC, not first-responder trust), turns on park-on-stop and the player address. The old terminal instructions moved to [the relay guide](docs/relay.md) for headless boxes; port and connection checks sit under **Advanced**.
- **Pick mods while creating a Fabric world.** The create form shows a Modrinth browser filtered to Fabric and the chosen Minecraft version, most popular first, with search. Picked mods install right after the world is created, each with its required dependencies (e.g. Fabric API), all checksum-verified; one mod that can't be installed is reported by name and doesn't stop the others. Changing the version clears picks, since mods are version-specific.
- **Automatic Java.** Creating a world no longer asks about Java. Seed Hosting reuses a runtime it installed before, else a compatible Java already on the PC, else downloads Mojang's official runtime for that Minecraft release (the one the Minecraft launcher uses) into its own profile folder. The runtime manifest is SHA-1-pinned by Mojang's runtime list, every file is size- and SHA-1-checked, entries that would escape the folder are refused, and the install is atomic — a failed or tampered download leaves nothing behind. Nothing is installed system-wide. The **Memory** step keeps Java selection in a collapsed **Advanced: change Java** section for imported servers or deliberate changes; creating a world never asks for a runtime. The memory shown after creation matches the saved choice.
- **New logo.** A clean sprout mark — two leaves on a stem rising from a seed — on a graphite tile, painted in your accent colour. The splash builds it in sequence (seed lands, stem draws, leaves unfold, glow breathes) and small marks nudge on hover; reduced-motion settings are respected. App, tray, launcher and Windows icons are regenerated from the same geometry.

### Changed
- **No EULA checkbox.** The create form states “By creating a world you agree to the Minecraft EULA” with a link beside **Create my world**, and the native confirmation repeats it with the EULA address; the backend still refuses creation without that consent.
- The join panel note now points at the public-address option as well as the always-on PC and VPN choices.
- **Several servers on one PC.** **My server → Your servers** lists every server this PC holds, marks the one in use, and switches between them with **Use this server**. Creating or importing another server now adds it instead of being refused; each keeps its own world, launch settings, backups and ownership record. Only the server in use can run, and switching is refused while one is running.
- **Delete a server.** **Delete…** removes one server after a native confirmation: its managed copy, the backups it alone kept and its ownership record. A server whose ownership is not safely held here (uncertain, fenced, or hosted elsewhere) refuses to be deleted, because that record is what blocks double-hosting. The folder you originally imported, other servers, your group and your playit tunnel are never touched.
- `npm run check:library` — visible Electron check: import adds a second server, the list marks the one in use, switching moves it, cancelling the native confirmation keeps everything, and approving deletes that server and falls back to the one that is left.
- **Advanced bring-your-own-agent support.** The optional advanced panel connects to an already approved playit agent on the always-on PC and creates or reuses one Minecraft Java tunnel. Automatic agent installation and management belong to the normal one-click workflow described above. Neither workflow changes router, firewall or startup settings. The credential is imported only through the native file picker and stored OS-encrypted (`safeStorage`), never in snapshots, logs or on screen. **Create public address** reuses a matching tunnel instead of creating duplicates, and refuses to act unless the always-on player gateway is configured and its player port differs from its control port. **Check address** reports *reachable* only after verifying the tunnel belongs to this agent, is enabled, targets exactly the configured gateway, and answers a real Minecraft Server List Ping through the public address; a reserved-but-unreachable address says so, and the copy button stays disabled until a check succeeds. See [public address](docs/playit.md).
- `npm run check:playit` — visible Electron check for the panel: opt-in default state, native file-picker cancel, safe failure message, and persistence across reload.

### Fixed
- **Graceful relay readiness.** The CLI installs shutdown handlers before announcing its listening ports, avoiding abrupt termination during public-address initialization.
- **Wayland minimize.** Tiling compositors that ignore native minimize can hide Seed Hosting to its recoverable tray instead. Desktop checks resize an isolated floating window and use the real Linux Secret Service.
- **Group verification errors.** Contradictory membership data no longer masquerades as a network/VPN failure; unverified holder claims remain hidden.
- **Deleting a server no longer risks other servers' backups.** Backup objects live in one content-addressed store shared by every server on the PC, so deletion now removes only the deleted server's own execution folder and ownership record, then prunes the revisions nothing references. The same share also fixed **Free up space**, which previously would have removed another server's execution folder and its revisions.
- **The join panel no longer implies a VPN address works for everyone.** The always-on PC address is now labelled *Through your always-on PC (may require VPN)*, so it is not mistaken for a public address.


## 0.4.0-alpha

**Alpha. Keep your own world backups.** Everything is renamed to **seedhost**: the repository, package, Windows executable (`SeedHost.exe`), relay binary, IPC channel, profile folder (`%APPDATA%/SeedHost`) and invitation code prefix (`SEEDHOST-…`).

### Added
- **Guided friend invitations.** Friends offers two clear paths — **Invite a friend** and **I have an invitation**. **Check invitation** reviews the group, address, expiry and full relay fingerprint from the code itself, locally: it never contacts the relay, consumes the invitation or proves connectivity. **Review & join group** shows a native confirmation built from the independently decoded code, re-checks it after consent, and verifies the saved relay and endpoint before reporting success. Nothing is downloaded or started.
- **Clear recovery.** Cancelling keeps your entries for a retry; a used code asks for a fresh invitation; damaged or expired codes explain the next step; a different configured group is never silently replaced, and joining requires a stopped server. Codes that only work on the same PC say so and explain how to get one for another PC.

### Changed
- **Renamed to `seedhost`** (see above). Invitation codes created before the rename are not accepted; ask for a fresh invitation. A leftover profile from an earlier alpha under the old folder name is not read or moved automatically.
- **Honest membership wording.** "Members confirmed" is a successful read of the relay's membership, not who is online; failed refreshes show *Unreachable · retry* and clear stale members.

## 0.3.0-alpha

**Still an alpha. Keep your own world backups.** The app is now presented as **Seed Hosting**; your existing profile, worlds and identity are kept.

### Fixed
- **Creating a Fabric server on Minecraft 26.x failed** with "Fabric profile is missing its loader or intermediary". Releases from 26.1 on are unobfuscated, so Fabric's official server profile has no intermediary mappings (its loader metadata declares the placeholder `intermediary:0.0.0`). Setup now requires exactly the mappings Fabric declares: a matching intermediary on older releases, none on unobfuscated ones. Anything else still fails closed.
- Error messages read as plain sentences ("Couldn’t create the server: …") instead of internal method names and Electron IPC wrapper text.

### Changed
- **Seed Hosting.** The app's display name, logo and marquee are now Seed Hosting, with a cream seed sprouting two green leaves on a forest-green tile as the mark. Internal names were left unchanged at the time so existing worlds, identity and settings stayed where they are; everything was later renamed to `seedhost`.
- **Forest-night dark theme** with **Sprout** green as the standard accent (Lagoon and the others remain). Decorations use a sunflower seed-spiral pattern instead of a grid.
- **Creating a world is more interactive:** a live "Your new world" preview follows every choice and lists what's still needed, a dice button suggests world names, and picks animate.
- **New look.** A clean, crisp theme with a new deep-ink standard dark mode (no glows, haze or blur), soft tonal surfaces (or skeuomorphic "Tactile" ones, with crisp bevels and a CRT-style console), a new logo and app icon, and an animated splash screen.
- **Redesigned first-run setup guide.** A roomy two-column layout: a brand rail with the five steps, big picture cards for create / import / join, and a create form in clear numbered sections. Game type is picked with large tiles and memory with GB chips instead of dropdowns.
- **Separate pages.** My server, Console, Friends and Settings are now their own sidebar tabs instead of a right-hand inspector. Settings is split into Appearance, Network and App categories. A status marquee on My server shows the server, hosting, friends and backup state at a glance.
- **Frameless window, no title strip.** The sidebar runs to the top edge and the window buttons sit on the page itself: minimize, a fullscreen ⇄ borderless toggle (F11; Esc leaves fullscreen) and ✕. **Quit safely** now lives in the sidebar, because the native menu bar is gone with the frame.

### Added
- **Windows icon** (`apps/desktop/icon.ico`, 16–256 px), generated from the same mark, for shortcuts and packaging.
- **Appearance settings**, remembered on this PC: dark / light / system theme, five accent colours, Soft or Tactile surfaces, comfortable or compact density, reduced motion, and whether ✕ hides to the tray (default) or quits safely.

## 0.2.1-alpha

**Still an alpha. Keep your own world backups.**

### Added
- **Setup guide for new users.** First launch asks one plain question: create a new world, use a server you already have, or join a friend’s world. Progress saves automatically; reopen it any time from the sidebar. Friends and always-on PC steps are optional and skippable.
- **Create a server in-app.** Vanilla or Fabric, downloaded from official sources and checked before use. The latest Minecraft version and newest installed Java are picked for you; memory is a simple GB menu. Explicit Minecraft EULA consent; nothing starts until you press Start.
- **How to join** panel: shows `localhost`, this PC’s home-network address and port (from `server.properties`), and any always-on PC address.
- **Getting-started checklist** on an empty My server page, plus the big **create a server** button.
- **Backups** list with restore. Restoring keeps your current world and backs it up first; ownership is never rewound.
- **Mod browser** (Modrinth search, compatible versions, required dependencies) with repair/check for interrupted installs.
- **Friends groups** with single-use invitation codes on your always-on PC.
- **Player address through the always-on PC** (opt-in TCP gateway): players use one address; only the confirmed current host receives traffic.
- Simple Java & memory settings that preserve modpack argument files.

### Changed
- Plain-language UI: My server, Start/Stop server, Save backup, Free up space, Hand off to always-on PC, Take over hosting. File paths, IDs and fingerprints are folded under Technical details or Advanced.
- Mods, launch settings and console stay hidden until a server exists.

### Validation notes
- 383 automated tests pass (0 failed, 0 skipped); all 8 visible Electron desktop checks pass, including official Vanilla 1.21.1 creation through the new wizard.
- Earlier in this cycle, real Vanilla and Fabric 1.21.1 servers started, answered Minecraft status requests, saved, and moved between two profiles on one PC through the always-on PC path.
- **Not tested:** real player login/gameplay, two physical PCs over the internet, arbitrary modpacks, power loss. The Windows build is unsigned.
