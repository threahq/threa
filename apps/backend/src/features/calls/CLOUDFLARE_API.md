# Cloudflare Realtime API — encoded understanding & 0.3 spike open questions

`cloudflare.ts` is our adapter to Cloudflare Realtime (the SFU, formerly "Calls").
It was written against the **documented** HTTPS API without a live dev account.
This note records exactly what we encoded and what the **PR 0.3 hostile-matrix
spike must confirm against the real API** before any M1 client work. This is the
one sanctioned doc artifact for 0.2 (per the brief).

## What we encoded (documented, believed correct)

- **Base URL**: `https://rtc.live.cloudflare.com/v1/apps/{appId}` (overridable via
  `CLOUDFLARE_REALTIME_API_BASE`).
- **Auth**: `Authorization: Bearer {appSecret}` on every request. The secret is
  the media-plane credential and never leaves the backend.
- **Create session** — `POST /sessions/new` → `{ sessionId, sessionDescription?: {type, sdp}, errorCode?, errorDescription? }`.
- **Add local tracks (publish)** — `POST /sessions/{sessionId}/tracks/new` with
  `{ sessionDescription: {type:"offer", sdp}, tracks: [{location:"local", trackName, mid}] }`
  → `{ requiresImmediateRenegotiation, tracks:[{mid, trackName, errorCode?, ...}], sessionDescription?: {type:"answer", sdp} }`.
- **Pull remote tracks** — same `POST /sessions/{sessionId}/tracks/new`, body
  `{ tracks: [{location:"remote", sessionId: <publisherSession>, trackName}] }`
  → `{ requiresImmediateRenegotiation, tracks, sessionDescription?: {type:"offer", sdp} }`.
- **Renegotiate** — `PUT /sessions/{sessionId}/renegotiate` with `{ sessionDescription: {type:"answer", sdp} }`.
- **Close tracks** — `PUT /sessions/{sessionId}/tracks/close` with `{ tracks:[{mid}], force, sessionDescription? }`.
- Timeout: 8s per request; non-2xx and network/timeout errors surface as typed
  `CloudflareRealtimeError` (`CF_HTTP_ERROR` / `CF_NETWORK_ERROR` / `CF_TIMEOUT` /
  `CF_SESSION_CREATE_FAILED`), mapped to `HttpError` 502/504 at the service boundary.

## Open questions the 0.3 spike MUST confirm

1. **Session teardown.** CF exposes **no documented session-delete verb** — sessions
   are said to reap on their own inactivity timeout. `closeSession()` currently
   force-closes all tracks (`PUT .../tracks/close` with `force:true`, empty mids)
   as the closest available teardown, treated as best-effort. **Confirm** whether
   (a) a real session-delete endpoint exists, (b) `tracks/close` with force is the
   right teardown, and (c) the exact inactivity-timeout duration (it bounds how
   long a reaped-but-not-closed session lingers on the bill).
2. **Publish/pull response contract.** Confirm `requiresImmediateRenegotiation`
   semantics, whether the answer SDP is always present on publish, and the exact
   per-track error fields (`errorCode`/`errorDescription`) and their values.
3. **`mid` vs `trackName` ownership.** We treat `trackName` as client-minted and
   `mid` as the offer's m-line id. Confirm CF requires both on publish and that
   peers pull purely by `{sessionId, trackName}`.
4. **Simulcast / layered forwarding.** The plan flags this as decisive for free
   per-receiver adaptation. Pin the exact encodings/layers request shape and what
   the SFU forwards per receiver — NOT modeled here yet.
5. **`bidirectionalMediaStream` / `autoDiscover`.** Documented optional fields we do
   not send. Confirm whether any flow needs them.
6. **STUN/TURN + reachability.** Confirm the anycast STUN (`stun.cloudflare.com:3478`)
   and integrated TURN behavior on the enterprise TLS-443 fallback path.
7. **Error/status codes.** Confirm CF's HTTP status codes and body error codes so
   the `CloudflareRealtimeError` → `HttpError` mapping is accurate (e.g. distinguish
   auth failure, unknown session, quota).

Findings feed back into `cloudflare.ts` (shapes), `service.ts` (teardown), and the
handlers before M1 starts.

## 0.3 spike status (per question)

The 0.3 hostile matrix has two halves. **Half A** (control-plane matrix,
`apps/backend/scripts/calls-spike/`) ran fully against real backend instances + a
local fake-CF recorder and is GREEN (see `SPIKE_FINDINGS.md`). **Half B**
(`scripts/calls-spike/live-cf/`) answers the questions below against the _real_ CF
API and is **BLOCKED-ON-CREDS** — every `cf-*.ts` script is written and fails fast
with a clear message until `CLOUDFLARE_REALTIME_APP_ID` / `_APP_SECRET` are set.

| #   | Question                                                                                                       | Status                         | Evidence / who answers it                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Session teardown verb + inactivity timeout                                                                     | **BLOCKED-ON-CREDS**           | `live-cf/cf-1-session-lifecycle.ts` probes DELETE vs `tracks/close force:true` and post-teardown liveness. Half A confirmed the _backend side_: the sweeper DOES invoke `closeSession()` (a `PUT .../tracks/close force:true` empty-tracks) on a reaped endpoint's session (matrix-2, recorded by the fake CF). The exact CF verb + timeout duration still need the live API. |
| 2   | Publish/pull response contract (`requiresImmediateRenegotiation`, answer-SDP presence, per-track error fields) | **BLOCKED-ON-CREDS**           | `live-cf/cf-2-publish-pull.ts` (two real browser peers, fake media) logs the exact response shapes and asserts media flows (getStats bytes > 0).                                                                                                                                                                                                                              |
| 3   | `mid` vs `trackName` ownership; pull by `{sessionId, trackName}`                                               | **BLOCKED-ON-CREDS**           | `cf-2` — the puller resolves the publisher's `cf_session_id` + advertised trackNames from our roster and pulls by them; confirms CF requires both `mid` (offer m-line) and client-minted `trackName` on publish.                                                                                                                                                              |
| 4   | Simulcast / layered-forwarding request shape                                                                   | **BLOCKED-ON-CREDS**           | `live-cf/cf-4-simulcast-probe.ts` posts baseline vs `simulcast.encodings[]` publish variants and records which CF accepts; `cf-2` confirms with real SDP.                                                                                                                                                                                                                     |
| 5   | `bidirectionalMediaStream` / `autoDiscover`                                                                    | **BLOCKED-ON-CREDS**           | `cf-4` includes a variant carrying both optional flags to observe whether any flow needs them.                                                                                                                                                                                                                                                                                |
| 6   | STUN/TURN + reachability (TLS-443 fallback)                                                                    | **BLOCKED-ON-CREDS** (partial) | `live-cf/cf-3-reachability.ts` TCP-probes `rtc.live.cloudflare.com:443`, `stun.cloudflare.com:3478`, `turn.cloudflare.com:443/3478` (no creds needed) + an authenticated signaling round-trip; the strict-NAT / enterprise-egress / network-handoff / Safari-iOS cases are a documented manual matrix in that script.                                                         |
| 7   | Error/status codes (auth failure, unknown session, quota)                                                      | **BLOCKED-ON-CREDS**           | `cf-1` hits a bogus session id + a bad bearer to capture CF's real status/body codes so the `CloudflareRealtimeError → HttpError` mapping can be pinned.                                                                                                                                                                                                                      |

To execute Half B: obtain a CF Realtime dev app, then
`CLOUDFLARE_REALTIME_APP_ID=… CLOUDFLARE_REALTIME_APP_SECRET=… bun apps/backend/scripts/calls-spike/live-cf/cf-1-session-lifecycle.ts`
(and cf-2/3/4). Fold the answers back into this doc + `cloudflare.ts` before M1.
