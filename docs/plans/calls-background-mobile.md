# Calls in the background on a phone

Status: **Built, not measured.** All three chunks shipped as PRs #1622, #1623 and
#1625 (Stack #1624); nothing here has been run on real hardware yet, which is
what the §Verification list is for.

"What the code actually does today" and every line reference below describe the
source **as of `b6760411`**, before this stack — that is what the chunks were
planned against, and it is deliberately not rewritten, so the problem statement
still reads as it did. Where the build diverged from the plan, the divergence is
recorded in place, next to the deliverable it changed.

## The ceiling, stated up front

Slack and Teams get the system call overlay because they are native apps. Every
mechanism behind that overlay is a native API with no web equivalent:

| What Slack/Teams do                                                      | The API                                                          | Available to a PWA                     |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| System in-call UI, status-bar call chip, call log, Bluetooth hook-switch | Android `ConnectionService` / telecom                            | No                                     |
| Ring over the lock screen                                                | Full-screen intent (`USE_FULL_SCREEN_INTENT`, Android 14+ gated) | No                                     |
| Floating call bubble over other apps                                     | `SYSTEM_ALERT_WINDOW`                                            | No                                     |
| Survive backgrounding indefinitely                                       | Foreground service, `microphone` type                            | No                                     |
| iPhone parity                                                            | CallKit + PushKit VoIP push                                      | No — Apple restricts PushKit to native |

So: we cannot build our own call overlay, and we cannot join the system one,
without a native shell. The cheap native path is a **TWA** (Trusted Web
Activity): the same web app inside an Android app shell that can own a
foreground service, a `ConnectionService`, and a full-screen intent, talking to
the page over a message channel. That is a real project with a Play Store
listing attached — a separate decision, not a patch.

Everything below is the web ceiling, which on Android is higher than it looks.

## What the code actually does today

Verified against `apps/frontend/src/calls/call-manager.ts` (1560 lines, one
`CallManager` class owning session, socket, transport, capture, lease):

- **No Media Session anywhere.** `grep mediaSession apps/ packages/ tests/` is
  empty. Nothing sets metadata, action handlers, or playback state.
- **Remote audio is per-track.** `attachRemoteAudio` (`call-manager.ts:1109`)
  creates one `<audio>` per pulled remote track and removes it on
  `stopPull`/track-end (`detachRemoteAudio`, `:1127`). Before the first peer
  track arrives — ringing out, or a solo call — no audio element exists at all.
  So the Media Session precondition ("actually playing audio") is not met for
  the part of the call where a lock-screen control would matter most.
- **Two silent-teardown branches, not one.** The socket `connect` handler
  (`:745`) re-joins with the same incarnation, then:
  - `:767` — a _different_ endpoint id means the lease was reaped and the server
    minted a fresh endpoint; the transport is bound to the old one, so it
    `teardown()`s. No state, no explanation. This is the locked-phone case.
  - `:775` — the re-join itself rejecting also `teardown()`s, equally silently.
    The design doc named only the first; both need the same landing state.
- **The lease-renew branch is NOT silent — it has the wrong copy.** A renew
  whose ack is `CALL_LEASE_SUPERSEDED` (`:1192`) routes to `handleTakenOver`
  (`:797`), which tears down and writes `DisplacedCall`, rendering
  `CallMovedChip` — "Call moved to another device". Server-side,
  `CallEndpointRepository.renewLease` returns null for a superseded epoch **and**
  for a swept (`status = 'closed'`) endpoint (`repository.ts:1086`), so a
  lease reaped while the phone was locked lands on takeover copy. That is a
  correction to the design doc's "the user unlocks to no call and no reason":
  depending on which signal wins the race, they get nothing, or they get told
  their call moved to a device they never touched.
- **Lease constants confirmed.** `ENDPOINT_LEASE_TTL_MS = 45_000` (both
  `apps/frontend/src/calls/config.ts:17` and
  `apps/backend/src/features/calls/config.ts:83`), renew at TTL/3 = 15s
  (`LEASE_RENEW_FRACTION`), sweep 15s (`CALL_SWEEP_INTERVAL_MS`). **Read only —
  no chunk here changes them.**
- **The manager already owns a `visibilitychange` listener** (`acquireWakeLock`,
  `:1259-1285`) plus a `devicechange` one, both detached in
  `removeSessionListeners` (`:1454`) precisely because a stray listener retains
  the session closure. Lifecycle instrumentation extends that set; it does not
  add a parallel listener rig.
- **Deps are fully injected.** `CallManagerDeps` (`:121`) carries every browser
  API the manager touches (`requestWakeLock`, `acquireUserMedia`, `locks`,
  `createAudioContext`, …) and every test builds a `CallManager` with fakes.
  Media Session gets the same treatment — no global monkey-patching, and jsdom's
  missing `navigator.mediaSession` never has to be faked.

Unverified, taken from the user's own measurement: Chrome 150 accepts
`hangup` / `togglemicrophone` / `togglecamera` action handlers and exposes
`setMicrophoneActive` / `setCameraActive`. Nothing in this repo proves it, and
jsdom cannot.

## PR stack

Three chunks, bottom to top. All three edit `call-manager.ts`, so they stack
rather than run in parallel; the ordering is otherwise driven by §3 feeding §2
(the freeze flag below) and by putting the chunk whose copy is most likely to
churn on top, where a rewrite rebases nothing.

```
main
 └── feat/calls-lifecycle-log          (§3)
      └── feat/calls-media-session     (§1)
           └── feat/calls-ended-while-away  (§2 + §4)
```

---

### 1. `feat/calls-lifecycle-log` — base `main`

The design's own first step: one locked-phone test should answer what Android
does, with timestamps, before anyone argues about a TTL.

**Deliverables**

- `apps/frontend/src/calls/lifecycle-log.ts` — a bounded module ring, shaped
  like `call-store.ts` (module state + `useSyncExternalStore` subscribe; the
  sanctioned non-React store pattern here, not a new hidden singleton):
  `recordCallLifecycleEvent(entry)`, `getCallLifecycleEvents()`,
  `subscribeCallLifecycle(fn)`, `clearCallLifecycleLog()`, cap `CALL_LIFECYCLE_LOG_MAX = 200`.
  Entry: `{ at: number; kind: CallLifecycleKind; detail?: string }` with
  `CALL_LIFECYCLE_KINDS` as the const-array source of truth (INV-31/33):
  `visible | hidden | freeze | resume | pagehide | pageshow | socket_connect |
socket_disconnect | lease_renew_ok | lease_renew_failed | rejoin_same_endpoint |
rejoin_new_endpoint | rejoin_failed | teardown`.
  **Not cleared on teardown or on the next call's start** — the log exists to
  explain a call that already died; clearing it at teardown would erase exactly
  the evidence. Bounded instead. Cleared only by `clearCallLifecycleLog`, wired
  into the account flush next to `resetCallStoreCache`.
- `call-manager.ts`: fold the existing `visibilitychange` handler and new
  `freeze` / `resume` / `pagehide` / `pageshow` listeners into one
  `installLifecycleListeners(session)` stored on `session.onLifecycle`, detached
  in `removeSessionListeners`. `freeze`/`resume` are `document` events,
  `pagehide`/`pageshow` are `window` events. The wake-lock re-acquire keeps
  riding the same visibility handler (INV-35 — one listener, two jobs, not two
  listeners).
- `call-manager.ts`: record `socket_connect` / `socket_disconnect` in the
  existing socket handlers, the three re-join outcomes in the `connect`
  continuation, `lease_renew_ok` / `lease_renew_failed` (with the ack `code` as
  `detail`) in `startLeaseTimer`, and `teardown`.
- `apps/frontend/src/components/call/call-controls.tsx`: a scrollable log
  section inside the existing `ConnectionDiagnostics` popover (`:149`), under
  the RTT/loss/quality list, plus a Copy control. The popover is reachable on a
  phone — `CallControls` renders in `TinyGalleryView` and `FullscreenView` of
  the mobile drawer. Copy confirms in place with an icon swap in the same
  footprint, never a `toast.success` (INV-63, INV-21); the popover is a fixed
  `max-h` with `overflow-y-auto` so a growing log never resizes it.

**Tests**

- `apps/frontend/src/calls/lifecycle-log.test.ts` — pushing `MAX + 5` entries
  keeps the newest `MAX` and drops the oldest (assert the surviving list, not a
  count, INV-23); `subscribeCallLifecycle` fires on record and unsubscribes;
  `clearCallLifecycleLog` empties it. `vi.setSystemTime` for deterministic `at`.
- `apps/frontend/src/calls/call-manager.test.ts` (extend) —
  - after `startCall`, dispatching `visibilitychange` (hidden/visible), `freeze`,
    `resume` on `document` and `pagehide` on `window` appends the matching
    entries in order;
  - `socket.fire("disconnect")` then `"connect"` appends
    `socket_disconnect`, `socket_connect`, `rejoin_same_endpoint`;
  - with `socket.joinAck.endpointId` changed, the same sequence appends
    `rejoin_new_endpoint`; with `socket.failJoin = true`, `rejoin_failed`;
  - the lease renew records `lease_renew_ok`, and a `CALL_LEASE_SUPERSEDED` ack
    records `lease_renew_failed` with that code as `detail`;
  - **leak guard:** after `leaveCall()`, dispatching `freeze` appends nothing
    (the listeners are detached — the same failure `removeSessionListeners`
    exists to prevent).
- `apps/frontend/src/components/call/call-controls.test.tsx` (extend) — seed the
  log, open the diagnostics popover, assert the entries render newest-first with
  their kind; click Copy and assert the clipboard payload plus the in-place
  confirmation (no toast).

**Excluded**

- Any change to `ENDPOINT_LEASE_TTL_MS`, `LEASE_RENEW_FRACTION`, or
  `CALL_SWEEP_INTERVAL_MS`. That is the decision this chunk exists to inform.
- A settings-page or standalone diagnostics surface. The log survives teardown
  and the next call's start, so starting any call and opening the existing
  popover reads the previous call's tail — a new permanent surface for raw event
  rows would be product clutter (INV-36).
- Sending the log anywhere (telemetry, backend). Copy-to-clipboard is the whole
  export story.

**Why this boundary:** a reviewer sees one bounded ring, one listener-lifecycle
change inside a method that already manages listeners, and one popover section.
No behavior changes: nothing reads the log to make a decision yet.

---

### 2. `feat/calls-media-session` — base `feat/calls-lifecycle-log`

The closest thing to a call overlay the web gives us: on Android a media
notification with the call's title, a mute toggle and a hang-up button, reachable
from the lock screen — and a signal to the OS that this page is doing something
worth keeping alive.

**Deliverables**

- `apps/frontend/src/calls/media-session.ts` — `createCallMediaSession()`
  returning a `CallMediaSession`:
  `activate({ title, subtitle })`, `setTitle(title)`,
  `setHandlers({ hangup, toggleMicrophone, toggleCamera })`,
  `setMicrophoneActive(active)`, `setCameraActive(active)`, `release()`.
  It owns **one long-lived `<audio>`** for the session's life: a self-contained
  silent-WAV `data:` URI (no network, CSP-safe), `loop = true`, not muted,
  started inside the start gesture.

  **Built at 8 seconds, generated at runtime.** Chromium classifies a player
  whose `duration` is under `kMinimumContentDuration` (5s) as _transient_ and
  builds no controllable media session for it, and `loop` does not raise
  `duration` — so the short clip the plan implied would have shipped the whole
  chunk as a no-op on Android with every unit test green. `SILENT_WAV_SECONDS` /
  `SILENT_WAV_SAMPLE_RATE` are the source of truth; generating rather than
  embedding keeps ~64KB of zeros out of the bundle.

  Every `navigator.mediaSession.setActionHandler`
  call is individually `try`/`catch`ed — an unsupported action throws
  `TypeError` and must not take the supported ones down with it. `release()`
  pauses and removes the element, clears each handler, nulls `metadata`, and sets
  `playbackState = "none"`.

- `call-manager.ts`: `CallManagerDeps.createMediaSession(): CallMediaSession | null`
  (production wires `createCallMediaSession()` when `navigator.mediaSession`
  exists, else null — INV-12/13, constructed once, injected, so no test touches a
  real Media Session). **Built on `CallManager` (`this.mediaSession`), not on
  `CallSession`:** activation happens inside the start gesture, before the
  session object exists, and `setCallTitle` can arrive at any point in the join
  window — a session-owned field would silently drop the title pushed while
  joining, which is the normal case.
  - `runStart` activates it **before** the transport connect and before the first
    capture, so a call that is only ringing out already owns a session. Only the
    hang-up action is registered there: `setMuted`/`setCameraOn` both early-return
    without a session, and a null handler is what removes a control from the
    notification, so no button is shown before it can act. `wireMediaSessionToggles`
    adds mute — and camera only on a video call — after the capture, seeded from
    the live state (the API's toggles default to inactive, so an unseeded
    notification shows a live call as muted and the first tap mutes).
  - Handlers: `hangup → void this.leaveCall()`,
    `toggleMicrophone → this.setMuted(!muted)`,
    `toggleCamera → void this.setCameraOn(!cameraOn)` — the existing controller
    methods, no parallel path (INV-35).
  - `setMuted` / `setCameraOn` mirror into `setMicrophoneActive` /
    `setCameraActive` so the notification's toggles match the app.
  - `teardown` and `hangupSync` both `release()`, in the same block that releases
    the wake lock.
- `CallController.setCallTitle(title: string)` — thin pass-through to
  `mediaSession.setTitle`. The manager holds a `streamId`, not a name, and stream
  names resolve out of the workspace caches through
  `apps/frontend/src/hooks/use-stream-name.ts` (frontend `CLAUDE.md`: one
  resolver, no hand-rolled lookups), which is a hook. So the resolved label is
  pushed in, not pulled.
- `apps/frontend/src/components/call/use-call-media-session-title.ts` — a hook
  calling `useStreamName(workspaceId, streamId, "generic")` and pushing the
  result through `useCallManager().setCallTitle` in an effect. Called once from
  `CallDock`; `streamIdForLabel` moves above `CallDock`'s early return (it is
  pure) so the hook is unconditional. One more consumer of the existing resolver,
  not a fifth copy of the lookup.

**Tests**

- `apps/frontend/src/calls/media-session.test.ts` — drive `createCallMediaSession`
  with an injected fake `navigator.mediaSession`-shaped object and a fake audio
  element factory: `activate` plays the element and sets metadata;
  a `setActionHandler` that throws `TypeError` for `hangup` still leaves
  `togglemicrophone` registered; `release()` pauses + removes the element,
  clears every handler and nulls the metadata.
- `apps/frontend/src/calls/call-manager.test.ts` (extend, fake
  `createMediaSession` dep) —
  - `activate` is called during `startCall` before `transport.connect`
    (assert against the transport's `_events` ordering log), i.e. a ringing-out
    call has a session;
  - the registered `hangup` handler triggers a real leave (assert the emitted
    `call:leave`);
  - `setMuted(true)` calls `setMicrophoneActive(false)`; `setCameraOn(true)`
    calls `setCameraActive(true)`;
  - `leaveCall()` and the store-flush `hangupSync` path each call `release()`
    exactly once;
  - a null `createMediaSession` (unsupported platform) leaves the whole start
    path working — no throw, phase still `connected`.
- `apps/frontend/src/components/call/call-dock.test.tsx` (extend) — seed a named
  stream in the workspace cache, mount `CallDock` in a connected call with a fake
  `CallController`, assert `setCallTitle` received the resolved stream name (and
  that a DM resolves to the peer's name, the case a hand-rolled lookup gets
  wrong).

**Excluded**

- Consolidating remote audio into one element. `attachRemoteAudio`'s
  per-track elements exist for the AEC reference and `setSinkId`; the silent
  element is additive and does not replace them.
- A service-worker notification (§5 — see _Not building_ below).
- Any lock-screen artwork. `MediaMetadata.artwork` needs a same-origin image
  pipeline for avatars; title + subtitle is the honest v1.

**Why this boundary:** a reviewer sees one new collaborator with its own test, an
injected dep, and mirror calls at three existing sites. Nothing about session
lifetime or teardown ordering changes. If Chrome refuses a session for a silent
element (the one real risk — flagged, unverified), this chunk is the only one to
revisit.

---

### 3. `feat/calls-ended-while-away` — base `feat/calls-media-session`

Never disappear silently, and never claim the call "moved to another device"
when the truth is "your phone was locked and the lease lapsed".

**Deliverables**

- `apps/frontend/src/stores/call-store.ts`: `DisplacedCall` gains
  `reason: "taken_over" | "ended_while_away" | "connection_lost"`. **Built with a
  third reason the plan did not have** — see the mapping correction below. The
  interface name stays —
  renaming it (and `CallMovedChip`, `useDisplacedCall`, the dock branch, the e2e
  selector) is churn with no behavior in it.
- `call-manager.ts`: `CallSession.suspendedSinceRenew: boolean`, set by the
  chunk-1 `freeze` and `pagehide` handlers, cleared on every successful lease
  renew. `freeze`/`pagehide` only — a plain desktop tab switch fires
  `visibilitychange` and must not be read as "the phone was locked".
- Reason selection, by signal:
  - `call:endpoint:closed` push (`:732`) → `"taken_over"`, unconditionally. The
    server addressed it to this endpoint under the call-row lock; it is the one
    unambiguous takeover signal. Existing copy and the e2e assertion at
    `tests/browser/calls.spec.ts:236` are unchanged by design.
  - re-join returning a different endpoint id, a failed re-join, and a
    `CALL_LEASE_SUPERSEDED` renew →
    `suspendedSinceRenew ? "ended_while_away" : "connection_lost"`. All three are
    ambiguous from the client (a reaped lease and a superseded one are the same
    null from `renewLease`); the freeze/pagehide evidence is the only thing that
    tells them apart, which is why this chunk sits on top of the instrumentation.

    **Correction to the plan as first written.** It mapped these to
    `suspendedSinceRenew ? "ended_while_away" : "taken_over"`, which reintroduces
    the exact falsehood the chunk exists to remove. Nothing in that branch is
    evidence of another device: a >45s network gap on a desktop that never froze
    (tunnel, Wi-Fi switch, VPN flap) reaps the lease the same way, and the socket
    `disconnect` handler only demotes to `reconnecting`, so a session can sit
    there indefinitely waiting for it. Only the `call:endpoint:closed` push
    proves a takeover, so only it may claim one.

  - The two `teardown()`-only branches now write the notice **after** teardown,
    the ordering `handleTakenOver` already uses (teardown clears the store, so a
    notice written before it would be wiped).

- `apps/frontend/src/components/call/call-moved-chip.tsx`: copy switches on
  `reason` — `"taken_over"` keeps "Call moved to another device" / "Rejoin
  here"; `"ended_while_away"` reads "Call ended while your phone was locked";
  `"connection_lost"` reads "Call ended — this device lost its connection". All
  three keep the same one-tap action. The action stays a `takeover: true` launch bound to
  `expectedCallId`: the user's own stale endpoint may still hold a lease, so a
  plain join would 409 and re-ask a question the chip already answered.
  **No auto-rejoin** — it would re-open the mic with no gesture.
- `apps/frontend/src/lib/platform.ts` — `isIosWebKit()` (UA `iPhone|iPad|iPod`,
  plus `MacIntel` + `maxTouchPoints > 1` for iPadOS).
- `apps/frontend/src/components/call/ios-lock-notice.tsx` — a one-line banner
  shaped exactly like `CaptureErrorBanner` (INV-35), rendered by
  `MobileCallDrawer` beside the capture banner, only when `isIosWebKit()`:
  locking the phone ends the call. Static from mount, fixed row — no layout
  shift (INV-21), no toast, no dismissal state. **Built for `standard`/`full`
  only, not the plan's `contentMode !== "min"`:** `min` and `compact` are
  fixed-height dark pills (compact is a hard 72px, all of it spoken for by the
  control row), so a permanent banner there clips the controls and paints a
  light surface on a dark one. `CaptureErrorBanner` shares that placement but is
  transient and exceptional; this notice is permanent for every iOS user.

**Tests**

- `apps/frontend/src/calls/call-manager.test.ts` —
  - **rewrite the existing F3 test** (`call-manager.test.ts:775`, currently
    asserting `phase: "idle"` and nothing else): a re-join with a new endpoint id still tears down **and**
    now writes `displacedCall` with `reason: "taken_over"` when the page never
    froze, and `reason: "ended_while_away"` after a dispatched `freeze` (and
    again after a `pagehide`);
  - a failed re-join (`socket.failJoin = true`) writes the same notice rather
    than vanishing;
  - a successful lease renew clears `suspendedSinceRenew`, so a freeze followed
    by a good renew followed by a takeover still reads `"taken_over"`;
  - the `call:endpoint:closed` push keeps `reason: "taken_over"` even after a
    freeze (the existing takeover tests at `:328` and `:365` extended, not
    replaced).
- `apps/frontend/src/components/call/call-dock.test.tsx` (extend) — seeding each
  reason renders its own copy, and both keep the Rejoin + Dismiss actions.
- `apps/frontend/src/components/call/mobile-call-drawer.test.tsx` (extend) — with
  a stubbed iOS `navigator`, the notice renders in the drawer's non-`min` modes
  and is absent otherwise; on a non-iOS UA it never renders.
- `tests/browser/calls.spec.ts` — unchanged. The takeover flow still asserts
  "moved to another device" because the push branch is untouched; that it still
  passes is the regression signal. Run with
  `bunx playwright test --project=calls --workers=2`.

**Excluded**

- Auto-rejoin. Explicitly not wanted.
- `CALL_ACCESS_REVOKED`. `startLeaseTimer` acts only on `CALL_LEASE_SUPERSEDED`,
  so a user removed from the host stream mid-call keeps a "connected" UI over a
  socket the server has already unbound (`signaling-gateway.ts:316-321`) — a real
  adjacent bug, found while reading this path. It needs its own copy and an
  action-less chip (Rejoin is wrong when access is gone), so it belongs with
  stream-access work, not here. Recorded so it is not lost.
- `use-visual-viewport.ts`'s private `isIOS`. Folding it in changes a 545-line
  viewport suite from a chunk about copy.
- Lease tuning. Still gated on the §3 data.

**Built beyond this section, deliberately:**

- `detectSingleActiveCapture` now delegates to `isIosWebKit()`. The plan excluded
  touching it, on the assumption the predicates differed; they were byte-identical
  at `b6760411`, so the delegation preserves behaviour exactly and INV-35 is
  better served by one probe than two. It keeps its own name and doc, because a
  single-active-capture rule is a different claim from a platform fact.
- `CallDock` opens an iOS call at `standard` rather than `compact`. The notice is
  gated to the modes with room for it, and `compact` is what an audio call would
  otherwise land on — a warning the user never sees is not a warning.
- `IosLockNotice` also renders on the three desktop surfaces, beside their capture
  banners (INV-35). `useIsMobile()` is viewport-based, so an iPad — and an iPhone
  in landscape — never mounts `MobileCallDrawer`, and gating the warning there
  would hide it from exactly the devices `isIosWebKit()` detects.

**Why this boundary:** a reviewer sees one store field, one derived reason, three
call sites that already tore down now saying why, and one banner. It is also the
chunk whose wording Kris is most likely to rewrite, which is why it sits on top.

---

## Not building

**§5, the service-worker ongoing-call notification.** On Android it duplicates
what the Media Session notification already gives (lock-screen presence, a
hang-up affordance), and it does not buy the thing that would actually matter —
survival. Only a foreground service keeps a page alive, and a service worker
cannot own one. Its click handler can focus the PWA, but it cannot resume a
frozen page's media. So it adds a notification-permission dependency and a second
notification surface for no new capability. Revisit only if the §3 data shows the
Media Session notification is unreliable on Android.

## Verification — real hardware, both platforms, §3 log on

1. Lock 30s, unlock — call still up? Read the log for what fired while locked.
2. Lock 2 min, unlock — call still up, or the §2 "ended while your phone was
   locked" chip (never the takeover copy)?
3. Switch to another app for 2 min.
4. Take a real phone call mid-Threa-call.
5. Lock screen shows the call (title = the stream/DM name), the mute toggle
   tracks the app, and hang-up from the lock screen actually ends the call.
6. iOS: the notice is visible in the drawer, and locking lands on the same
   explicit ended state rather than a silent vanish.

Then, and only then, revisit the 45s / 15s / 15s lease numbers. Raising the TTL
trades directly against ghost endpoints — a dead device holds a participant slot
for the whole TTL.

## Assumptions that could not be verified from source

- Chrome's call-specific Media Session actions and `setMicrophoneActive` /
  `setCameraActive` (user-measured in Chrome 150; jsdom cannot test them, which
  is why they sit behind an injected collaborator).
- That Chrome grants a media session to a **silent** looping audio element. This
  is the standard trick and the reason §1 is shaped this way, but if Android
  refuses it, chunk 2's silent element is the piece to revisit — routing remote
  audio through one long-lived element instead would work but costs the
  per-track AEC/`setSinkId` shape.
- What Android actually does to a frozen PWA holding a WebRTC session. That is
  the whole point of chunk 1.
- Whether the freeze path can be driven from Playwright. Chromium exposes
  `Page.setWebLifecycleState` over CDP (`context.newCDPSession(page)`), which
  would make §2's re-join branches e2e-testable; it may refuse on a page holding
  a live peer connection. Worth one spike, but no chunk's completion depends on
  it — the unit tests dispatch `freeze`/`pagehide` directly.
