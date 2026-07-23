# Calls UX overhaul — plan

Status: **draft, awaiting ratification**. Owner: Kris. Design source: Seer `calls-ux-cb8f33` (v7) — light/dark, 4-mode global drawer, Speaker↔Grid, desktop top/side dock.

Voice/video calls shipped (stack #1410→#1424, released #1454, migrated to the `calls` feature flag default-on in #1461). Live prod use surfaced two bugs and a thin in-call UX. This overhaul fixes the bugs and rebuilds the call surface into one snap-resize system shared across mobile (drawer) and desktop (dock).

## Locked design decisions (from the Seer exploration)

- **One surface, snap modes.** Mobile = a **global** drawer pulled from the top; desktop = its **twin**, a resizable dock docked **top** or **side** (user config). Both snap between discrete sizes and follow the user across streams (call is app-chrome, not stream content — already mounts once at app root).
  - Mobile modes: **Tab** (live dot + timer only) → **Bar** (timer + current speaker + mute/camera/leave) → **Tiny gallery** (speaker pinned + flip + device menu) → **Fullscreen**.
  - Desktop **Top** dock snaps: Tab → Bar → Gallery → Fullscreen (drag bottom edge). **Side** dock snaps: Rail → Panel → Wide → Fullscreen (drag left edge). Config picks top (narrow window) or side (widescreen).
- **Light + dark.** Call chrome, including desktop fullscreen gutters, uses theme tokens and follows light/dark. Video and media tiles keep a near-black bed in both themes. Mobile fullscreen remains near-black. Hang-up stays destructive-red; live dot + speaking ring stay primary-amber in both.
- **Speaker ↔ Grid.** Segmented switch in the fully-open/fullscreen view. Grid = equal tiles. Speaker = active speaker large + the rest as a filmstrip. Mobile filmstrip is bottom-only. Desktop offers **bottom** or **side** filmstrip (screen-shape choice). Layout choice persists.
- **Camera / source picker.** Desktop: a device menu with **Camera / Microphone / Speaker** groups, each listing every device (webcams, capture cards, virtual cams). Mobile: one-tap **front/back flip** + the full device sheet one tap deeper.
- **Self-view** is a small draggable PiP in Speaker; an equal tile in Grid. Camera-off shows avatar-initials (theme-aware surface).

## Non-negotiable constraints

- Gate every new surface on the **`calls` feature flag** via the current subject-keyed read path — never re-introduce the bespoke `callsEnabled` boolean. (Confirm exact hook API in grounding before writing chunk 1.)
- Reuse the existing outbox/socket delivery (INV-4/7) for the auto-end event — no ad-hoc publish.
- Media objects never go through React state (current call code attaches `srcObject` by ref on `mediaEpoch` bumps) — preserve that.
- Persist user prefs (layout, dock position, filmstrip side) client-side (localStorage), keyed so they survive reload; do not add columns for these.
- INV-25 comments, INV-63 toasts, INV-14 Shadcn primitives, INV-40 Link-vs-button all apply.

## PR stack (bottom → top, linear; gh-stack)

Bug fixes first, per Kris. Build order: **camera-picker → call-end** (camera is unambiguous; call-end has a lifecycle-semantics fork awaiting Kris's confirm), then 3 lays the shared foundation and 4–6 build the surfaces.

### 1 · `fix/calls-camera-picker` — pick & switch camera / input source

**Bug:** camera is grabbed at random and can't be changed; the device menu lists only mic + speaker; `cameras[]`/`selectedCameraId` are scaffolded but dead; no `facingMode`/flip.

- Wire `selectedCameraId` into `CallDeviceState`; thread a video `deviceId` (`{ exact }`) through `setCameraOn`/`doCaptureAndPublish`; add `switchCameraDevice(deviceId)` to the controller and a mobile front/back flip (`facingMode` toggle, or deviceId cycle where facingMode is unsupported); republish the video track on switch without dropping the call.
- **Desktop:** add a **Camera** group to `DevicePickerMenu` (above Microphone/Speaker), listing `devices.cameras`.
- **Mobile:** a first-class **flip** control (front/back) on the bar; the full camera/mic/speaker list behind the device button.
- **Tests:** switching camera updates `selectedCameraId` and re-publishes with the new deviceId; picker renders camera devices; flip toggles facingMode. Use scoped `spyOn`, no `mock.module` (INV-48).
- **Acceptance:** in a live call, open devices → pick a different camera → feed switches; on mobile, flip swaps front/back.
- **Screenshots:** desktop device menu with camera group open; mobile flip.

### 2 · `fix/calls-auto-end` — end an emptied call promptly + never show a dead call as live

**Corrected understanding (grounding):** the call _does_ end today, but slowly. An emptied roster → `empty_grace` (`CALL_EMPTY_GRACE_MS`, default **45 s**) → a 15 s sweeper flips `empty_grace → ended` and emits `stream:call_ended` (outbox). A raw socket **drop** is not a leave — the participant lingers `joined` until the endpoint lease lapses (`ENDPOINT_LEASE_TTL_MS`, **45 s**) before grace even starts. Worst case last-person-gone → ended ≈ lease + grace + sweep (~105 s). During all of that the timeline card shows a live **Join** for a functionally-dead call — the "we couldn't stop it" symptom.

**Semantics fork (awaiting Kris — default in bold):**

- **(a) Explicit last-leave ends immediately.** When a user clicks _Leave_ and they are the last `joined` participant, transition `active → ended` in that same tx and emit `stream:call_ended` — skip grace. Grace stays only for disconnect-driven emptiness (the reconnect buffer it was designed for). **Default: yes.**
- **(b) Client safety net.** In `active-calls-store`, treat a call in grace / `participantCount === 0` as not-live: hide the Join affordance and the rejoin bar, show "Call ended". Never render a live Join for a dead call. **Default: yes.**
- **(c) Ghost from a peer's socket-drop** (peer closed the tab without leaving): they stay `joined` for the lease TTL, so _your_ leave isn't "last" and the call lingers. Options: shorten the disconnect→empty path, or add an explicit **"End call for everyone"** for the workspace-admin/host. **Default: add the client safety net now + file ghost-lease tuning as a fast-follow; do NOT change lease TTL in this PR.**

**Build (once ratified):**

- Server: in `leaveCall` / `leaveCallAsUser` empty branches (`service.ts:445-460`, `:528-535`), when the leave is explicit and `countJoined === 0`, call `appendCallEnded` (transition to `ended`, reason `completed`) in-tx instead of `enterGraceIfEmpty`; keep grace for the reaper path (`service.ts:1326-1329`). CAS on status/roster-version, not a bare flag (INV-20/66).
- Client: `active-calls-store.updateCallParticipants` + the card/rejoin-bar liveness gate treat count-0 / grace as ended.
- **Tests:** explicit last-leave ends now + emits `stream:call_ended` (assert event content, INV-23); disconnect path still enters grace (unchanged); concurrent double-leave ends once (race, produce the value via the repo's own NOW()/version path, INV-66); client hides a count-0 call.
- **Acceptance:** 2-party call, both click Leave → card gone within one event, no ~45 s ghost.
- **Screenshots:** live card → ended card, before/after timing note.

### 3 · `feat/calls-ui-foundation` — theme-aware chrome + shared primitives + state model

Foundation for 4–6; minimal user-visible change (existing dock keeps working).

- **Light/dark:** call chrome uses theme tokens (`bg-background`, `text-muted-foreground`, `bg-muted`, `ring-primary`, `text-destructive`). Desktop fullscreen chrome and stage gutters use those tokens. Video and media tiles, mobile fullscreen, and the on-video caption gradient (`call-tile.tsx:88-94`) remain fixed dark surfaces with white captions.
- Extract shared primitives: `CallTile` (video + camera-off avatar + name/mute + speaking ring), `CallControlBar` (mic/camera/flip/devices/diagnostics/leave + a screen-share **slot** rendered disabled/hidden — see Deferred), `LayoutToggle` (Speaker/Grid segmented, Shadcn).
- **State model** on the call store: `surfaceMode` (`tab|bar|gallery|fullscreen`), `layout` (`speaker|grid`), `dockPosition` (`top|side`), `filmstripSide` (`bottom|side`) — persisted to localStorage; selectors in `call-store-hooks`.
- **Tests:** store defaults + persistence roundtrip (integer/string prefs, read back through the store — no hand-crafted fixtures); tile renders camera-off avatar; control bar renders the flip + device buttons; light/dark snapshot of the bar via the real-component harness.
- **Acceptance:** existing call still works; toggling OS theme reflows the bar; no regression in the current dock.

### 4 · `feat/calls-mobile-drawer` — 4-mode global drawer

- Replace the mobile collapsed-pill / expand path with the drawer: Tab → Bar → Tiny gallery → Fullscreen, driven by `surfaceMode`.
- Drag from the top handle; **snap to nearest detent on release** with a velocity bias; chat stays live behind Tab/Bar/Tiny-gallery; Fullscreen is opaque with a chevron/flick to collapse.
- Global: renders at app root regardless of active stream (Tab visible on any screen while a call is live).
- Desktop path unchanged in this chunk (still the current dock until chunk 6).
- **Tests:** mode transitions update `surfaceMode`; snap picks nearest; drawer renders on a non-call stream; controls present per mode (Tab = timer only; Bar adds mute/cam/leave; Tiny gallery adds flip/devices). Mount real components (INV-39).
- **Acceptance:** on a phone viewport, pull the tab through all four modes and back; call visible across stream navigation.
- **Screenshots:** the four modes (emulated phone) + the tab on another stream.

### 5 · `feat/calls-speaker-grid` — Speaker/Grid layouts

- `LayoutToggle` switches `layout`; render **Grid** (equal, responsive 2×2→3×3) and **Speaker** (active speaker + filmstrip).
- Mobile Speaker filmstrip = bottom. Desktop Speaker filmstrip = **bottom or side** per `filmstripSide`; a control to switch it. Self-view = draggable PiP in Speaker, equal tile in Grid.
- Active-speaker selection reuses the existing analyser signal.
- **Tests:** toggle updates `layout` + persists; grid renders N tiles; speaker renders one large + filmstrip; desktop filmstrip side switches.
- **Acceptance:** in fullscreen, switch Speaker↔Grid; on desktop switch filmstrip bottom↔side; choices persist across reload.
- **Screenshots:** mobile Speaker + Grid; desktop Grid / Speaker-bottom / Speaker-side.

### 6 · `feat/calls-desktop-dock` — resizable top/side dock

- Desktop surface becomes the resizable dock: **Top** (snaps Tab→Bar→Gallery→Fullscreen, drag bottom edge) or **Side** (snaps Rail→Panel→Wide→Fullscreen, drag left edge), `dockPosition` config with a small top/side switch; persists.
- Drag-resize with the same snap physics as mobile; Side pushes content (no overlap) like the old right rail; Fullscreen covers the content area; sidebar nav stays live and switching streams keeps the dock.
- **Tests:** resize snaps to nearest detent; dock-position switch persists; side dock reflows content (no overlap); fullscreen covers content not the sidebar.
- **Acceptance:** on desktop, drag the dock through its snaps in both orientations; switch top↔side; layout persists.
- **Screenshots:** top dock (Gallery snap) + side dock (Panel snap) + the top/side config.

## Deferred (binding — do not build)

- Screen-share (net-new; the control bar reserves a disabled slot only).
- Recording, reactions, virtual/blurred backgrounds, per-tile hover menus (pin/mirror/fill), raise-hand.
- Per-workspace feature-flag **admin UI** (separate initiative; the flag system already gates calls).
- CF DPA / processor-register entry (ops gate, tracked in the calls plan, not code).
- Server-persisted layout prefs (client localStorage only for now).

## Process

- **build-feature** per-chunk rhythm: brief → Opus/medium implement → Opus/xhigh adversarial verify → fix loop → `/gh-stack` + `/create-pr` → `/code-review`. Screenshots in every PR body (real-component harness / emulated viewports) and posted to the Threa channel.
- **gh-stack** for the whole chain (`gh stack init` bottom→top, `submit --auto`, `sync --prune` after merges). Never hand-rolled branches.
- After the last chunk: whole-stack top-model review, then an **adversarial GPT-5.6 (Sol)** external pass; fold surviving findings; report per-PR links.
- Local gates before any merge: `bun run typecheck`, `bun run test:unit`, relevant `test:e2e` / `test:browser`.
