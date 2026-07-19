/**
 * Half B / CF-1 — session lifecycle + teardown (answers CLOUDFLARE_API.md Q1, Q7).
 *
 * 1. createSession → record the sessionId + whether an SDP offer is returned.
 * 2. Probe teardown: try a DELETE on the session (is there an undocumented
 *    session-delete verb?), then the `tracks/close force:true` path our
 *    `closeSession()` uses. Record both status codes / bodies.
 * 3. Re-poll the session (a no-op `tracks/new` with an empty track set, or a
 *    renegotiate) to observe whether it still exists after teardown, and — left
 *    running by an operator — how long CF's inactivity timeout keeps it billable.
 * 4. Hit a bogus session id + a bad bearer to capture CF's real error status/body
 *    codes so the CloudflareRealtimeError → HttpError mapping can be pinned (Q7).
 *
 * BLOCKED without a CF dev app — see cf-env.ts. This script performs no media.
 */

import { requireCfCreds, makeLiveCf, cfFetch, type CfCreds } from "./cf-env"

async function probeTeardown(creds: CfCreds, sessionId: string) {
  const results: Record<string, unknown> = {}
  // (a) Is there a session-delete verb? (undocumented — probe it.)
  results.delete = await cfFetch(creds, "DELETE", `/sessions/${encodeURIComponent(sessionId)}`).catch((e) => ({
    error: String(e),
  }))
  // (b) The teardown our adapter actually uses.
  results.tracksCloseForce = await cfFetch(creds, "PUT", `/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
    tracks: [],
    force: true,
  }).catch((e) => ({ error: String(e) }))
  return results
}

async function main() {
  const creds = requireCfCreds()
  const cf = makeLiveCf(creds)

  console.log("CF-1 session lifecycle — live probe\n")

  const created = await cf.createSession()
  console.log("createSession →", { sessionId: created.sessionId, hasOffer: !!created.sessionDescription })

  const teardown = await probeTeardown(creds, created.sessionId)
  console.log("teardown probes →", JSON.stringify(teardown, null, 2))

  // Does the session survive teardown? A renegotiate against a live session should
  // answer; against a reaped one it should error — record which.
  const afterTeardown = await cfFetch(creds, "PUT", `/sessions/${encodeURIComponent(created.sessionId)}/renegotiate`, {
    sessionDescription: { type: "answer", sdp: "v=0\r\n" },
  }).catch((e) => ({ status: -1, json: String(e) }))
  console.log("post-teardown renegotiate →", JSON.stringify(afterTeardown))

  // Error-code mapping (Q7): unknown session id + bad bearer.
  const unknownSession = await cfFetch(creds, "PUT", `/sessions/does-not-exist/renegotiate`, {
    sessionDescription: { type: "answer", sdp: "v=0\r\n" },
  }).catch((e) => ({ status: -1, json: String(e) }))
  const badAuth = await cfFetch({ ...creds, appSecret: "invalid-secret" }, "POST", `/sessions/new`, {}).catch((e) => ({
    status: -1,
    json: String(e),
  }))
  console.log("unknown-session status →", JSON.stringify(unknownSession))
  console.log("bad-auth status →", JSON.stringify(badAuth))

  console.log(
    "\nQ1/Q7 evidence captured above. Record the inactivity-timeout duration by leaving a\n" +
      "created-but-untorn session idle and re-polling it on an interval (operator step)."
  )
}

if (import.meta.main) main()
