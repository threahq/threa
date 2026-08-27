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
local fake-CF recorder and is GREEN. **Half B**
(`scripts/calls-spike/live-cf/`) EXECUTED 2026-07-19 against the real CF API (dev
app, dashboard-provisioned). Headline: **CF-2 confirmed real two-way media through
our production proxy** — publisher 159KB sent / puller 197KB received, both ICE
connected. Answers below; fixes already folded into `cloudflare.ts`/`service.ts`.

| #   | Question                                                         | Status                 | Answer (live evidence 2026-07-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Session teardown verb + inactivity timeout                       | **ANSWERED**           | No delete verb: `DELETE /sessions/{id}` → 405 "reserved for future WHIP/WHEP". `tracks/close` with EMPTY tracks → 406 "Expecting at least 1 track" — the old `closeSession()` was a silent no-op. Real teardown (now implemented): `GET /sessions/{id}` (state; exists) → force-close the enumerated mids. A never-connected/disconnected session GETs 410 `session_error` within ~2 min — CF self-reaps; nothing to close.                                                                                                                                                                                                        |
| 2   | Publish/pull response contract                                   | **ANSWERED**           | Publish answer: `requiresImmediateRenegotiation:false` + `sessionDescription {type:"answer"}` present + per-track `{mid, trackName}` echoes (no errorCode on success). Pull: `requiresImmediateRenegotiation:true` + an OFFER; client answers via `PUT /renegotiate` → 200. **Timing is part of the contract**: SDP must go up immediately, candidate-less (production behavior) — waiting out ICE gathering first → 502 `session_error` ("Session appears to be disconnected"). Also: `sessions/new` REJECTS a `{}` body (400 `decoding_error`: sessionDescription) but accepts an ABSENT body (no-SDP create, `hasOffer:false`). |
| 3   | `mid` vs `trackName` ownership; pull by `{sessionId, trackName}` | **ANSWERED**           | Confirmed: publish requires both (mid = offer m-line, trackName client-minted); the puller pulled by the publisher's `cf_session_id` + trackName resolved from our roster, and media flowed.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Simulcast / layered-forwarding request shape                     | **OPEN (M3)**          | `cf-4`'s synthetic-SDP variants can't probe it: CF strictly validates SDP (400 "SDP contains no ice-ufrag") and 500s (`internal_error`) on the simulcast variants with fake SDP. Needs a real-browser-SDP probe. Not an M1 blocker — v1 publishes single-encoding tracks (proven by cf-2); the camera ladder uses `applyConstraints` + `maxBitrate`.                                                                                                                                                                                                                                                                               |
| 5   | `bidirectionalMediaStream` / `autoDiscover`                      | **OPEN (M3)**          | Same synthetic-SDP limitation (500 `internal_error`). No v1 flow needs them — cf-2 proved the full flow without either flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 6   | STUN/TURN + reachability (TLS-443 fallback)                      | **ANSWERED (partial)** | `rtc.live.cloudflare.com:443`, `turn.cloudflare.com:443` and `:3478` all reachable + authenticated signaling round-trip OK. `stun.cloudflare.com:3478` TCP-probe failed from this network but srflx candidates still gathered (UDP fine). The strict-NAT / enterprise-egress / handoff / Safari-iOS manual matrix remains (documented in cf-3).                                                                                                                                                                                                                                                                                    |
| 7   | Error/status codes                                               | **ANSWERED**           | Bad bearer → 401 `unauthorized`. Unknown-session GET **hangs** (no fast 404) — the adapter's request timeout (`CF_TIMEOUT` → 504) is load-bearing. Invalid body → 400 `decoding_error`; wrong-state ops → 406 (`invalid_params`, `invalid_session_description`); disconnected session → 410 `session_error`; synthetic-SDP simulcast → 500 `internal_error`. `cfErrorDescription` now surfaces in the proxy's 502 details.                                                                                                                                                                                                         |

Rerun: `CLOUDFLARE_REALTIME_APP_ID=… CLOUDFLARE_REALTIME_APP_SECRET=… bun apps/backend/scripts/calls-spike/live-cf/cf-1-session-lifecycle.ts`
(and cf-2/3/4) **from the repo root** (the harness spawns `apps/backend/src/index.ts` by relative path).
