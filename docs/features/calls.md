---
title: Voice & Video Calls
status: in-development
audience: internal
kind: feature
since: 2026-07 (M1, flag-gated)
surfaces: [stream-header, call-dock, incoming-call-overlay, timeline, rejoin-bar, sidebar]
invariants: [INV-4, INV-8, INV-20, INV-41, INV-57, INV-62]
entry_points:
  - apps/backend/src/features/calls/
  - apps/frontend/src/calls/
  - apps/frontend/src/components/call/
  - packages/types/src/feature-flags.ts
public_site: false
summary: >
  Slack-huddle-class 1:1 DM calls (M1): start from a DM header, ring the peer,
  audio/video in the browser with media routed through the Cloudflare Realtime
  SFU — never through Threa's servers. Gated behind the `calls` feature flag
  (workspace scope, default on) and the Cloudflare Realtime app credential; group
  calls, screen share, call chat, and transcription are deferred to later milestones.
related: [../plans/voice-video-calls.md, ../deployment.md]
---

## What it is (v1 scope)

A **call** is a set of rows in call-scoped tracking tables (INV-57) attached to an
existing DM or channel stream — never a new stream type. M1 ships the **1:1 DM
call**: one person starts a call from a DM header, the peer is ringed (in-app
overlay + web push), both join a docked audio/video surface, and a timeline card
records the call live and then as an ended summary.

Media rides the **Cloudflare Realtime SFU**: each participant holds one
`RTCPeerConnection` to Cloudflare, publishes its mic/camera once, and pulls each
peer's tracks. **Threa's servers carry control signaling only** — the media plane
never transits Threa. That is the load-bearing v1 invariant (see
[Invariant candidates](#invariant-candidates)).

In scope for M1: DM call start (header button, `/call`, profile modal), ring +
decline + cancel + missed-call, docked dock with mute/camera, device pickers,
connection diagnostics, the live/ended timeline card, the reload rejoin bar, the
sidebar live dot, and the crash-safe lease sweeper.

**Deferred** (each its own milestone; designs frozen in the plan's Deferred
sections): group calls (M2), screen share + PiP + wake lock (M3), the docked call
chat stream (M4), and transcription/the scribe seat (its own follow-up). See
[`docs/plans/voice-video-calls.md` §Rollout](../plans/voice-video-calls.md) and its
Deferred sections.

## Architecture summary

Backend feature folder `apps/backend/src/features/calls/` (INV-51): `service.ts`
(transaction-owning CAS state machines + the CF proxy), `repository.ts`,
`handlers.ts` (REST + CF proxy endpoints), `signaling-gateway.ts` (the `/calls`
socket namespace), `sweeper.ts`, `cloudflare.ts` (the CF adapter behind the
`RealtimeMediaApi` seam), `access.ts` (`checkCallAccess`), `config.ts`.

### Data model (migration `20260719120000_calls.sql`)

Four split tracking tables (the review's central verdict — one collapsed row can't
carry invitations, membership, endpoints, and consent):

- **`calls`** — one per stream call; `status` active | empty_grace | ended, `mode`
  video | audio_only, `media_transport` sfu (p2p reserved for the Later direct
  mode). Partial unique index on `(workspace_id, stream_id) WHERE status IN
('active','empty_grace')` enforces one active call per stream — glare resolves
  via `INSERT ... ON CONFLICT DO NOTHING` + a same-tx re-read (INV-20).
- **`call_invitations`** — one row per ring attempt; `status` ringing | accepted |
  declined | busy | expired | cancelled | superseded.
- **`call_participants`** — membership grants (humans only); `status` joined |
  left | removed, actor-conditional transitions.
- **`call_endpoints`** — admitted device/tab sessions; the **lease** lives here
  (`lease_expires_at`), fenced on an integer `epoch`.

### Identity: endpoints, incarnations, leases

- **Endpoint** = one admitted device/tab session per user (`callep_` id).
- **Media incarnation** = one `CallManager` lifetime; a reload within the lease is
  the same endpoint lease but a new incarnation with a fresh CF session. Stale
  incarnations are fenced (rejected 409).
- **Lease** = persisted liveness, renewed at TTL/3 by the socket-owning instance,
  swept by CAS. A crashed instance's endpoints reap on lease lapse — an in-memory
  timer would wedge the stream's active-call slot forever.

### Signaling and the CF proxy

- **`/calls` Socket.io namespace** (control plane): `call:join`, `call:leave`,
  `call:state` (mirrors server-owned mute/camera claims + roster versions),
  `call:lease:renew`, and the `call:roster` fan-out. All small; roster carries a
  monotonic version so a reordered update is dropped, not trusted.
- **HTTPS CF proxy endpoints** (Express, `checkCallAccess` + endpoint/incarnation
  fenced, rate-limited): create session, renegotiate, publish/pull/close tracks —
  thin pass-throughs holding the CF app secret, which never reaches a client. CF
  session creation runs outside DB transactions (INV-41), CF-call-first then the
  DB write, so no row ever claims a session that was never created.
- **`MediaTransport` boundary = provider boundary**: the client speaks in track
  kinds and peer refs, never SDP; `CloudflareSfuTransport` is the one adapter.

### Delivery and timeline

- Durable lifecycle rides the **outbox** as stream-scoped events (every v1
  participant is a host-stream accessor): `call_started` (a slotted broadcast row —
  the live card) and `call_ended` (a patch carrying `{durationMs,
participantUserIds, endedReason}` so the historical card renders with no fetch).
- The sidebar live dot rides `call:started`/`call:ended` fanned workspace-wide for
  public channels / to member user-rooms for private/DM.
- The card's liveness **defaults dead**: it renders live only when the active-calls
  cache confirms a live call with that id — a stale live card with a Join button is
  an interactive lie.

### Frontend

- `CallManager` (`apps/frontend/src/calls/call-manager.ts`) — account-scoped,
  workspace-agnostic; owns the `/calls` socket, the single CF `RTCPeerConnection`
  behind `MediaTransport`, the per-session renegotiation queue, local capture,
  leases, and one AudioContext per call (created in the join gesture).
- Components (`apps/frontend/src/components/call/`): `CallDock` (on `side-panel`,
  non-modal), `CallTile`, `CallControls`, `IncomingCallOverlay`, `PreJoinGate`,
  `RejoinBar`, plus `CallCard` in the timeline.

## The flag

Calls are gated by **two independent switches**, both required:

1. **`CloudflareRealtimeConfig`** (env, backend-only) — `CLOUDFLARE_REALTIME_APP_ID`
   - `CLOUDFLARE_REALTIME_APP_SECRET` (+ optional `CLOUDFLARE_REALTIME_API_BASE`).
     Co-presence validated at boot (both or neither, INV-11); a single one set fails
     boot loudly. Absent ⇒ the backend boots fine but every calls surface answers
     **503 `CALLS_UNAVAILABLE`**. Resolved in `apps/backend/src/lib/env.ts`
     (`config.cloudflareRealtime.enabled`), consumed only by the CF proxy.
2. **`calls`** feature flag (workspace scope, default **on**,
   `packages/types/src/feature-flags.ts`) — a per-workspace kill switch, resolved
   through the same registry as every other flag: the backend gates read
   `featureFlagService.getWorkspaceFlag(workspaceId, "calls")` (handlers +
   `/calls` gateway; the gateway also gates lease-renew so flipping off drains
   live calls within one lease TTL), the frontend reads
   `useFeatureFlag(workspaceId, "calls")` and renders no calls surface
   (`stream.tsx`, `user-profile-modal.tsx`) when off. A workspace opts out with a
   `subject_type='workspace'` override of `"off"`, written from the backoffice
   (control-plane only — there is no in-app toggle). Default-on means calls
   surface in every workspace where the env credential above is also present.

## Operational notes

- **Lease TTL** `ENDPOINT_LEASE_TTL_MS = 45s` (`config.ts`); renewed at TTL/3.
- **Empty grace** `EMPTY_GRACE_MS = 45s` — how long an emptied call sits in
  `empty_grace` before ending. Env-overridable via `CALL_EMPTY_GRACE_MS`.
- **Sweep cadence** `CALL_SWEEP_INTERVAL_MS = 15s` — the lease reaper's interval
  (`server.ts`), one SSOT shared with the spike harness. Env-overridable via
  `CALL_SWEEP_INTERVAL_MS`. Worst-case crash-recovery latency for a 1:1 call is
  grace + sweep (≈60s); a shorter calls-specific cadence is a tuning knob, not a
  redesign (SPIKE_FINDINGS §1). The e2e suite drives both low for determinism.
- **Sweeper** (`sweeper.ts`) does three idempotent CAS stages per tick: expire
  stale rings → missed-call activity; reap lapsed endpoint leases → participants
  `left` → emptied calls to `empty_grace` (and best-effort closes the CF session
  server-side); end `empty_grace` calls past their deadline → `call_ended`.
- **CF app provisioning** (one per environment, never shared) and the exact env-var
  placement (Railway backend service) live in
  [`docs/deployment.md` §Cloudflare Realtime app](../deployment.md).
- **Rate limits.** Ring-capable call creation (`POST /calls`) uses a dedicated tight
  budget (`calls-start`, 12/min/user) separate from the generous CF-proxy limiter
  (`calls`, 240/min), so ring-spam is capped without throttling renegotiation churn.
  **M2 follow-up:** add an invitee-side ring cooldown (per inviter→invitee pair) so a
  caller can't re-ring a declining peer in a tight loop; the creator-side budget does
  not bound that.

### Residuals / known gaps

- **Socket room membership outlives the lease.** A hostile socket that stops
  renewing keeps its Socket.io room membership until it disconnects, so it can still
  observe roster metadata of the call it was legitimately in, even though its
  media/lease die on the next reap and its own renews now ack `CALL_ACCESS_REVOKED` /
  `CALL_LEASE_SUPERSEDED` (and drop it from the rooms server-side). It is only the
  socket that never renews again that lingers. **Follow-up:** push server-initiated
  eviction via an outbox-driven `socketsLeave` on access-revoke/reap so a kicked
  member is dropped from the fan-out immediately rather than on its next renew or
  disconnect. Not built now — the renew-time re-check plus reap bounds the exposure
  to one lease TTL and only for a socket that stops renewing.

## Observability

Prometheus metrics on the backend registry (`apps/backend/src/lib/observability/metrics.ts`),
low-cardinality (no `workspace_id`) — fleet health, not per-tenant billing:

| Metric                                    | Type      | Labels                                                         | What it answers                                                                                   |
| ----------------------------------------- | --------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `call_cf_session_create_total`            | counter   | `status` (success\|error)                                      | CF session-create success rate                                                                    |
| `call_cf_session_create_duration_seconds` | histogram | —                                                              | CF session-create latency                                                                         |
| `call_cf_errors_total`                    | counter   | `operation`, `cf_code`                                         | connect failure by op + CF error code (renegotiation failures = `operation="renegotiate"`)        |
| `call_time_to_join_seconds`               | histogram | —                                                              | server-side join (endpoint admission) → CF session created (first binding only; rejoins excluded) |
| `call_ended_total`                        | counter   | `reason` (completed\|reaped)                                   | call-end reason distribution                                                                      |
| `call_ring_outcomes_total`                | counter   | `outcome` (accepted\|declined\|cancelled\|expired\|superseded) | ring outcomes                                                                                     |
| `call_sweep_reaped_total`                 | counter   | `kind` (endpoint\|participant\|grace_call\|expired_ring)       | lease-sweep throughput                                                                            |

Per-call egress GB (the bill), loss/RTT, and caption/STT metrics from the plan's
day-1 list belong to later milestones (egress is a CF-account-level signal; captions
and STT ship with transcription).

## Tests

- **Unit/integration** (`apps/backend/src/features/calls/*.test.ts`): every
  state-machine race from the review record (glare, join-vs-reap, removed-rejoin,
  lease-lapse-vs-renew, second-endpoint rejection), the gateway, and the CF proxy
  fencing.
- **Two-context Playwright e2e** (`tests/browser/calls.spec.ts`): happy path
  (ring → accept → both docks converge → leave → ended card), decline, abandonment
  (hang-up-before-answer records no missed call — the 1.3 regression pinned), and
  reload → rejoin. Runs against the dev-test stack with the **fake Cloudflare seam**
  (`tests/browser/fake-cf-runner.ts` — the spike's `fake-cf-server` in
  negotiationless mode) and fake media; assertions are on the control plane
  (roster/dock/phases), never getStats bytes.
- **Spike / hostile matrix** (`apps/backend/scripts/calls-spike/`): the manual
  control-plane matrix (two instances, `kill -9`, two devices, glare, grace/revive)
  — reference, not part of CI. Findings in
  `apps/backend/src/features/calls/SPIKE_FINDINGS.md`.

## Invariant candidates

- **Media never transits Threa (v1, absolute).** Call media and audio route through
  Cloudflare's SFU (already Threa's edge trust boundary), encrypted in transit, and
  never touch a Threa server — Threa stores call _metadata_ (rows, events) only,
  never audio. The security label the UI shows is **derived** from live state
  (`media_transport` + active generation), never stored, so it cannot disagree with
  reality. The transcription follow-up reintroduces a consented per-leg audio path
  with its own disclosure machinery; until then the invariant is absolute. Enforced
  by construction (there is no server-side audio path) and by the `RealtimeMediaApi`
  seam being the only media boundary.

## Release state

Calls were **released on by default** on 2026-07-20 by an explicit pre-launch product
decision, ahead of the items below. The list is kept because the unchecked entries are
still genuinely outstanding — it is the honest state of the feature, not a gate that
was satisfied.

- [x] Schema + state machines + CF proxy + `/calls` gateway shipped (PRs 0.1–0.2).
- [x] 1:1 DM lifecycle: ring, dock, mute/camera, timeline card, rejoin bar, sweeper
      (PRs 1.1–1.4).
- [x] Two-context e2e (happy/decline/abandonment/rejoin) green locally against the
      fake-CF seam; wired into the browser-tests CI workflow (path filters already
      cover `tests/browser/**`).
- [x] Observability counters implemented and exported on the metrics registry.
- [x] **CF Realtime app provisioned + env vars set — DEV** (2026-07-19,
      dashboard-created; the account-token API 403s despite Calls:Edit — see
      `SPIKE_FINDINGS.md` — so provision per-env apps via the dashboard). Staging
      and prod apps still needed, per [`docs/deployment.md`](../deployment.md).
      One app per environment; never share the secret.
- [x] **Half-B live-CF spike executed** (2026-07-19) — Q1-Q3/Q6/Q7 answered
      against the real dev app, **cf-2 confirmed two-way media through the
      production proxy** (159KB up / 197KB down, ICE connected), and three
      adapter contract drifts were found and fixed (`sessions/new` body,
      `closeSession` enumerate-then-close, immediate candidate-less SDP timing).
      Q4/Q5 (simulcast/optional flags) stay open for M3 — synthetic SDP can't
      probe them and v1 publishes single-encoding tracks. Answers in
      `CLOUDFLARE_API.md`; findings in `SPIKE_FINDINGS.md`.
- [ ] **Cloudflare on the GDPR processor/transfer register** — with SFU-first, CF is
      a content-level media processor from the first call. This is an **M1 exit
      gate** and a **compliance action, not a code change**: DPA coverage,
      media-path residency, retention (none — the SFU forwards, doesn't store). Do
      not flip the flag in an environment serving real users until this is on the
      register.
- [ ] **Observability dashboards** wired to the new counters (metrics are emitted;
      the panels/alerts are not built).
- [ ] **Hostile matrix green twice consecutively** against a real CF app (Half A is
      green against the fake; the dev app now exists, so the live re-run is
      unblocked and just needs to be executed).
- [ ] **Real browser media flow verified against live CF** using the production
      `CloudflareSfuTransport` (not only the spike probe scripts). Cf-2 (2026-07-19)
      already proved the production proxy + the production SDP timing contract
      (immediate, candidate-less — an ICE-gathering wait actively fails) with real
      media both directions; what remains is the same flow driven by the shipped
      frontend transport in a real session (dev stack + dev app, two browsers).

The DPA-register entry is the one that still carries real weight: it must land before
the product carries external users.
