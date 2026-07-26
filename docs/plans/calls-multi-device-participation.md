# Calls — same user on multiple devices

Status: **Feature 1 (takeover) planned in detail and in build.** Features 2–3 scoped only.

## Why

Two real workflows from daily use:

1. **Handoff.** Call in from the phone on the commute, arrive at the desk, join on
   the laptop — the session should _move_ to the laptop.
2. **Split roles.** Laptop shares the screen but its mic is broken, so the phone
   carries audio. Both legs live at once, deliberately.

A third, later: **presented mode** — join only to publish a screen, no mic/camera.

## What happens today

A second device is rejected. `CallService.admitEndpoint`
(`apps/backend/src/features/calls/service.ts:361`) throws 409
`CALL_ENDPOINT_ACTIVE` when a `connected` endpoint on a _different_ media
incarnation already exists for the participant. The frontend never passes
`takeover`, so the 409 surfaces as an error toast and nothing else.

Same-device reconnects are not affected: a `reconnecting` endpoint, an endpoint
with no incarnation yet, or one carrying _this_ incarnation is rebound to the
same row and epoch (`service.ts:380-397`).

The one-live-endpoint rule is enforced in the schema, not just in code:

```sql
CREATE UNIQUE INDEX idx_call_endpoints_live_per_participant
  ON call_endpoints (workspace_id, call_id, participant_id)
  WHERE status IN ('connected', 'reconnecting');
```

(`apps/backend/src/db/migrations/20260719120000_calls.sql:106`)

`ActiveElsewhereChip` (`apps/frontend/src/components/call/active-elsewhere-chip.tsx`)
is _not_ this case — it reports the Web Lock being held by another **tab** in the
same browser, not another device. In practice that chip barely fires: the REST
start runs _before_ `acquireLock`, so a second tab hits the same 409 first.

## Feature 1 — "Join on this device" (handoff)

The takeover **transition** exists server-side (`admitEndpoint` closes the prior
endpoint under the call-row lock, tears down its CF session after commit per
INV-41, and mints a higher epoch). What does not exist: a way to _reach_ it from
the client, and any signal to the device being displaced.

### Reachability — takeover is unreachable from the frontend today

`CallManager.runStart` always begins with the REST start
(`POST /api/workspaces/:id/calls`), so that is where the 409 lands. But
`startSchema` (`handlers.ts:19`) has no `takeover` field and `CallService.startCall`
neither accepts nor forwards one into `joinLockedCall` — only the socket
`call:join` path (`signaling-gateway.ts:45`) carries the flag, and the client
never gets there. So the flag is plumbed through REST start:

1. `startSchema` += `takeover: z.boolean().optional()`; handler passes it through.
2. `CallService.startCall` params += `takeover?: boolean`, forwarded into
   `joinLockedCall`.

### Telling the displaced device

Today the only signal is the lease renew failing with `CALL_LEASE_SUPERSEDED`,
and the renew interval is TTL/3 = **15s** (`leaseRenewIntervalMs`, `calls/config.ts`).
Its media dies the moment the CF session closes, so the displaced device shows
"Reconnecting…" for up to 15 seconds and then the call silently vanishes. Not
acceptable as the primary path.

So the server pushes it. `endpointRoom(callId, endpointId)` already exists for
exactly this ("control events are addressed here, never a user room") and has no
emitters yet — this is its first use:

3. `admitEndpoint` returns the **superseded endpoint id** alongside
   `closedCfSessionId`; `startCall`/`joinCall` propagate it up as
   `supersededEndpointIds` next to `closedSessionIds`.
4. After commit, the REST handler and the gateway (both hold `io`) emit
   `call:endpoint:closed { callId, endpointId, reason: "taken_over" }` to that
   endpoint's room.
5. **Only for a real takeover, never a rebind.** A rebind reuses the same
   endpoint id, so the room is the room the _joining_ device is about to sit in —
   emitting there would kill the device that just arrived. Guard on
   `closedEndpointId !== newEndpoint.id`.

The lease-renew `CALL_LEASE_SUPERSEDED` path stays as the backstop for a
partitioned device and routes into the same client handler, so the outcome is
identical whichever signal wins.

### The displaced device must not emit any leave

Both leave paths are wrong here and would damage the call the user just moved:

- `call:leave` (socket) → `leaveCall` → `cancelRingingByInviter`: on a DM call
  whose peer has not answered yet, taking over on the laptop would **cancel the
  ring** the laptop wants live.
- `leaveCallRest` (`POST /calls/:id/leave`) → `leaveCallAsUser` →
  `closeByParticipant` closes **every** live endpoint of the user — including the
  new device's.

So the displaced client tears down **locally only**. That is internal to
`CallManager` (`teardown()` is private and emits nothing), so no `CallController`
API change: the manager handles the socket event itself.

### The UI knows before the click

Kris's ruling: an action that fails and then asks "are you sure?" is the wrong
shape. The entry point should already know the call is on another device and
offer takeover as the action — the Teams framing, "take over" rather than "join".

The client can know: the active-calls store carries `participantUserIds`, kept
fresh by `call:participants_changed` and seeded per stream from the stream
bootstrap. `useCallOnAnotherDevice(workspaceId, callId)` is true when that roster
lists the viewer and no local session is on that call.

- The timeline call card's **Join** becomes **Take over** (and the row/menu action
  "Take over call on this device"), launching with `takeover: true`.
- The stream header's start menu collapses to a single **Take over** button: the
  running call already settled voice-vs-video, so the only open question is which
  device carries it.
- The rejoin bar asks for takeover too. It only ever shows while a live endpoint
  the viewer isn't on exists — this tab's own lapsed lease or another device — and
  takeover is a no-op in the first case, because a lapsed-socket endpoint is
  `reconnecting` and the rebind branch runs first.

The 409 prompt below stays as the **fallback**, not the main path: a device that
joined a second ago, a roster this client hasn't received, or an entry point on a
stream whose roster was never loaded.

### Frontend shape

6. `CallManagerDeps.startCallRest` and `CallManager.startCall` params gain
   `takeover?: boolean`.
7. `CallLaunchRequest` += `takeover?: boolean` (set by an entry point that already
   knows). `CallLaunchState` += `{ status: "takeover_prompt"; request }`. In
   `CallLaunchProvider.run`'s catch, an `ApiError` with code
   `CALL_ENDPOINT_ACTIVE` sets that state instead of `join_error` + toast; a new
   `takeOver()` action re-runs the same request with `takeover: true`. The dock
   already stays mounted for any non-idle launch state
   (`launching = launch.status !== "idle"`, `call-dock.tsx:61`), so the prompt
   renders where the join error renders today.
8. `PreJoinGate` renders it: "You're already in this call on another device" with
   primary **Join on this device** and ghost **Cancel**. ("Join again" gets a
   second button here when Feature 2 lands — deliberately absent now.)
9. `CallManager.wireSocket` handles `call:endpoint:closed`: gate on gen + callId +
   `endpointId === session.endpointId`, then `teardown()` and record a displaced
   notice. `clearCallState()` runs inside teardown, so the notice is a separate
   store field written after it and cleared on the next `setCallSession` / dismiss.
10. A `CallMovedChip` in `CallDock`'s idle branch (where `ActiveElsewhereChip`
    sits): "This call moved to another device", **Rejoin here** (launch with
    `expectedCallId` — which now takes over back) and **Dismiss**. A chip with an
    action, not a toast (INV-63).

### Also fixed, for free

The second-tab-in-the-same-browser case gets the same prompt instead of a bare
error toast, because it fails at the same 409.

### Known residual (accepted)

If the new device's capture fails _after_ the takeover commits, `rollbackStart`
calls the endpoint-free REST leave and the user ends up in the call on neither
device. The old device already shows the moved chip with **Rejoin here**, so
there is a way back; not worth a distributed rollback.

### Verification

Unit: service (takeover through REST start; rebind does not supersede), gateway +
handler (superseded room receives the event; a rebind does not emit), launch
context (409 → prompt → retry carries `takeover`), manager (endpoint-closed event
tears down locally and emits **no** leave).

Live: two Playwright contexts as the same user under `dev:test` — A joins, B
joins → prompt → **Join on this device** → A shows the moved chip within ~1s, B is
connected, and the roster carries exactly one participant.

## Feature 2 — "Join again" (two live legs)

This is the real change. It is a schema + roster-model change, not a flag.

- **Schema.** The partial unique index above has to go, replaced by a bounded
  rule (cap legs per participant; the cap must be enforced under the call-row
  lock so two racing joins can't both pass).
- **One-endpoint assumptions.** `CallEndpointRepository.findLiveByParticipant`
  (`repository.ts:1027`) returns _the_ live endpoint; `admitEndpoint` branches on
  it; `markLeftIfNoLiveEndpoint` already counts correctly but every caller that
  treats "the participant's endpoint" as singular needs auditing, including the
  CF pull allow-list (`assertPullableRefs`) and the roster's track registry.
- **Roster shape.** The roster is participant-keyed and the frontend renders one
  tile per participant. Two legs means tiles are endpoint-keyed, with the same
  human identity on two tiles — self-tile detection, the speaking ring, and the
  mirror rule (`resolveSelfMirror`) all key off "is this me" today.
- **Echo.** Two legs in the same room with mics live is a feedback loop. Either
  the second leg joins muted by default, or the client refuses to render/play
  audio from an endpoint whose participant is self (the safer rule — it is a
  local playback decision, and it also fixes hearing yourself on handoff overlap).
- **Leave semantics.** Leaving is already endpoint-scoped
  (`leaveCall(..., endpointId)`), so per-leg leave works; what needs deciding is
  whether "Leave" on one leg should offer "leave all my devices".

## Feature 3 — "Join in presented mode" (later)

Blocked on screen share, which does not exist yet (`getDisplayMedia` appears
nowhere in the frontend). Once dual-feed screen share lands, presented mode is a
join whose publish policy is screen-only. Note the schema already reserves
`calls.sharing_endpoint_id` for a server-owned share claim.

## Observed misbehaviour to confirm during the build

- Second-device join → error toast only (explained above: unhandled 409). Fixed
  by Feature 1.
- "Leave call" pressed on the phone while the laptop is the connected device did
  nothing visible. Most likely the phone's endpoint had already been reaped or
  closed, so `leaveCall` 404s on `CALL_ENDPOINT_NOT_FOUND` and the UI stays put —
  i.e. a stale local in-call state, not a remote-hangup feature. **Reproduce and
  confirm before designing around it.** Whatever the cause, a device must not
  present call controls for a call it no longer holds an endpoint on, and no
  surface should offer hanging up _another_ device (takeover is the sanctioned
  way to displace one).

## Suggested order

1. Handoff prompt + displaced-device state. **In build.**
2. Stale-endpoint UI audit (the "Leave did nothing" case).
3. Two live legs (schema + roster; own stack).
4. Presented mode, after screen share.
