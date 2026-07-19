/**
 * A local stand-in for the Cloudflare Realtime (SFU) HTTPS API, used by the
 * control-plane hostile matrix (Half A) so the calls surfaces run with
 * `cloudflareEnabled=true` WITHOUT a real CF dev account. It implements exactly
 * the four verbs `cloudflare.ts` calls (`sessions/new`, `tracks/new`,
 * `renegotiate`, `tracks/close`) and RECORDS every request, so a matrix can
 * assert the backend attempted a session teardown after a crash (the
 * `closeSession()` path is a `PUT .../tracks/close` with `force:true`, empty
 * `tracks`).
 *
 * This is NOT a media plane — it moves no RTP, answers with placeholder SDP, and
 * exists purely to exercise the backend's proxy + sweeper wiring against a real
 * HTTP boundary. Live media validation is Half B (`live-cf/`), which needs the
 * real CF dev credentials.
 */

export interface FakeCfRequest {
  method: string
  path: string
  sessionId: string | null
  body: unknown
  at: number
}

export interface FakeCfServer {
  url: string
  port: number
  /** Every request the backend made, in order. */
  log: () => FakeCfRequest[]
  /** Requests that were a session teardown (empty `tracks` + `force:true`). */
  closeCalls: () => FakeCfRequest[]
  reset: () => void
  stop: () => void
}

let sessionCounter = 0

export interface FakeCfOptions {
  /**
   * Omit the `sessionDescription` from every session/track response (and never
   * request renegotiation). The control-plane matrices don't care about SDP (no
   * real PeerConnection), but a REAL browser (the two-context Playwright e2e)
   * feeds any returned SDP to `RTCPeerConnection.setRemoteDescription`, which
   * rejects the placeholder string and tears the call down. In this mode the fake
   * forwards nothing — exactly the "media plane carries no media" seam the e2e
   * asserts against (roster/dock/phases from the control plane, never getStats):
   * the browser's local offer stays un-answered, the PC never connects, and the
   * call surface still converges through the `/calls` socket roster.
   */
  negotiationless?: boolean
}

/**
 * Start the fake CF server on `port` (0 ⇒ OS-assigned). The backend's
 * `CLOUDFLARE_REALTIME_API_BASE` must point at `${url}/v1/apps` so
 * `CloudflareRealtimeApi` builds `/${appId}/sessions/new` beneath it.
 */
export function startFakeCfServer(port = 0, options: FakeCfOptions = {}): FakeCfServer {
  const requests: FakeCfRequest[] = []
  const negotiationless = options.negotiationless === true

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      // Liveness probe for the Playwright `webServer` readiness check — not part
      // of the CF API surface, never called by the control-plane harness.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok", { status: 200 })
      }
      // Path shape: /v1/apps/{appId}/sessions/new
      //             /v1/apps/{appId}/sessions/{sessionId}/tracks/new
      //             /v1/apps/{appId}/sessions/{sessionId}/renegotiate
      //             /v1/apps/{appId}/sessions/{sessionId}/tracks/close
      const parts = url.pathname.split("/").filter(Boolean)
      const sessionsIdx = parts.indexOf("sessions")
      const sessionSeg = sessionsIdx >= 0 ? parts[sessionsIdx + 1] : null
      const sessionId = sessionSeg && sessionSeg !== "new" ? decodeURIComponent(sessionSeg) : null
      let body: unknown = null
      try {
        body = await req.json()
      } catch {
        body = null
      }
      requests.push({ method: req.method, path: url.pathname, sessionId, body, at: Date.now() })

      const tail = parts.slice(sessionsIdx + 1)

      // POST /sessions/new
      if (req.method === "POST" && sessionSeg === "new") {
        sessionCounter += 1
        return Response.json({
          sessionId: `fakesess_${sessionCounter}_${Math.random().toString(36).slice(2, 8)}`,
          ...(negotiationless ? {} : { sessionDescription: { type: "offer", sdp: "v=0\r\n// fake-cf offer\r\n" } }),
        })
      }
      // POST /sessions/{id}/tracks/new  (publish or pull)
      if (req.method === "POST" && tail[tail.length - 1] === "new" && tail.includes("tracks")) {
        const reqTracks = (body as { tracks?: Array<Record<string, unknown>> })?.tracks ?? []
        return Response.json({
          requiresImmediateRenegotiation: false,
          tracks: reqTracks.map((t) => ({ ...t })),
          ...(negotiationless ? {} : { sessionDescription: { type: "answer", sdp: "v=0\r\n// fake-cf answer\r\n" } }),
        })
      }
      // PUT /sessions/{id}/renegotiate
      if (req.method === "PUT" && tail[tail.length - 1] === "renegotiate") {
        return Response.json(
          negotiationless ? {} : { sessionDescription: { type: "answer", sdp: "v=0\r\n// fake-cf reneg\r\n" } }
        )
      }
      // PUT /sessions/{id}/tracks/close
      if (req.method === "PUT" && tail[tail.length - 1] === "close") {
        return Response.json({ tracks: [] })
      }

      return Response.json({ errorCode: "NOT_FOUND", errorDescription: "fake-cf: unhandled route" }, { status: 404 })
    },
  })

  const isClose = (r: FakeCfRequest): boolean => {
    if (r.method !== "PUT" || !r.path.endsWith("/tracks/close")) return false
    const b = r.body as { tracks?: unknown[]; force?: boolean } | null
    return !!b && b.force === true && Array.isArray(b.tracks) && b.tracks.length === 0
  }

  const boundPort = server.port ?? port
  return {
    url: `http://localhost:${boundPort}`,
    port: boundPort,
    log: () => [...requests],
    closeCalls: () => requests.filter(isClose),
    reset: () => {
      requests.length = 0
    },
    stop: () => server.stop(true),
  }
}
