# Calls — same user on multiple devices

Status: **scoped, not ratified.** Inventory only; no code written.

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
same browser, not another device.

## Feature 1 — "Join on this device" (handoff)

**The server already implements it.** `takeover: true` closes the prior endpoint
under the call-row lock, tears down its CF session after commit (INV-41), and
mints a higher epoch (`service.ts:399-419`). The signaling gateway accepts the
flag too (`signaling-gateway.ts:45`).

Work is frontend-only:

- Catch 409 `CALL_ENDPOINT_ACTIVE` on join/start and, instead of a toast, prompt:
  **Join on this device** (retry with `takeover: true`) / **Cancel**.
- The displaced device needs a clear terminal state, not a silent disconnect: it
  gets its endpoint closed out from under it and must render "This call moved to
  another device" with a rejoin affordance, not a generic transport error.

Open question: whether the displaced device's user should be _asked_ (a
confirm-on-the-old-device handshake) or simply told. Told is simpler and matches
the mental model — it is the same person on both ends.

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

- Second-device join → error toast only (explained above: unhandled 409).
- "Leave call" pressed on the phone while the laptop is the connected device did
  nothing visible. Most likely the phone's endpoint had already been reaped or
  closed, so `leaveCall` 404s on `CALL_ENDPOINT_NOT_FOUND` and the UI stays put —
  i.e. a stale local in-call state, not a remote-hangup feature. **Reproduce and
  confirm before designing around it.** Whatever the cause, a device must not
  present call controls for a call it no longer holds an endpoint on, and no
  surface should offer hanging up _another_ device (takeover is the sanctioned
  way to displace one).

## Suggested order

1. Handoff prompt + displaced-device state (frontend-only, server ready).
2. Stale-endpoint UI audit (the "Leave did nothing" case).
3. Two live legs (schema + roster; own stack).
4. Presented mode, after screen share.
