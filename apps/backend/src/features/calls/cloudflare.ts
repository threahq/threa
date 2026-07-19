import type { CloudflareRealtimeConfig } from "../../lib/env"

/**
 * Cloudflare Realtime (SFU) HTTPS client — the media plane's one adapter behind
 * the `RealtimeMediaApi` seam (the `MediaTransport` boundary of the plan: a
 * future >50-participant provider or the Later P2P direct mode slots in here
 * without touching product code). The app secret is a Bearer credential that
 * NEVER ships to a browser: every session/track operation proxies through the
 * backend under `checkCallAccess`.
 *
 * NEVER call any of these inside a DB transaction (INV-41): the service pattern
 * is CF-call-first, then the DB write, so a failed CF call fails the operation
 * before any row claims a session that was never created.
 *
 * The exact request/response shapes are pinned to CF's documented Realtime API
 * (see CLOUDFLARE_API.md) and are the throwaway-spike's job (PR 0.3) to confirm
 * against the live dev account before M1.
 */

export interface SessionDescription {
  type: "offer" | "answer"
  sdp: string
}

/** A track this endpoint publishes (offer carries it). */
export interface LocalTrackRequest {
  location: "local"
  /** CF track name peers pull by; we mint it from the endpoint + kind. */
  trackName: string
  /** The m-line id in the endpoint's offer this track maps to. */
  mid: string
}

/** A peer's track this endpoint pulls (CF answers with the SDP to add it). */
export interface RemoteTrackRequest {
  location: "remote"
  /** The publisher's CF session. */
  sessionId: string
  /** The publisher's track name (from the roster's published_tracks). */
  trackName: string
}

export interface TrackResult {
  mid?: string
  trackName?: string
  location?: "local" | "remote"
  sessionId?: string
  errorCode?: string
  errorDescription?: string
}

export interface CreateSessionResult {
  sessionId: string
  sessionDescription?: SessionDescription
}

export interface TracksResult {
  requiresImmediateRenegotiation: boolean
  tracks: TrackResult[]
  sessionDescription?: SessionDescription
}

export interface RenegotiateResult {
  sessionDescription?: SessionDescription
}

export interface CloseTracksResult {
  tracks: TrackResult[]
}

/**
 * The media-transport seam. One production implementation
 * ({@link CloudflareRealtimeApi}); the interface is the fake seam tests stub, so
 * no test ever reaches the network.
 */
export interface RealtimeMediaApi {
  createSession(): Promise<CreateSessionResult>
  renegotiateSession(sessionId: string, sdp: SessionDescription): Promise<RenegotiateResult>
  addLocalTracks(
    sessionId: string,
    params: { sdp: SessionDescription; tracks: LocalTrackRequest[] }
  ): Promise<TracksResult>
  pullRemoteTracks(sessionId: string, params: { tracks: RemoteTrackRequest[] }): Promise<TracksResult>
  closeTracks(
    sessionId: string,
    params: { mids: string[]; force?: boolean; sdp?: SessionDescription }
  ): Promise<CloseTracksResult>
  /** Best-effort teardown; CF sessions also die on their own inactivity timeout. */
  closeSession(sessionId: string): Promise<void>
}

/**
 * A typed CF failure. `status` is the HTTP status (0 on a timeout/network
 * error); `code` is our stable machine code; `cfErrorCode`/`cfErrorDescription`
 * carry CF's own error fields when the transport succeeded but CF reported a
 * body-level error. Callers map this to an `HttpError` at the surface.
 */
export class CloudflareRealtimeError extends Error {
  readonly status: number
  readonly code: string
  readonly cfErrorCode?: string
  readonly cfErrorDescription?: string

  constructor(
    message: string,
    params: { status: number; code: string; cfErrorCode?: string; cfErrorDescription?: string }
  ) {
    super(message)
    this.name = "CloudflareRealtimeError"
    this.status = params.status
    this.code = params.code
    this.cfErrorCode = params.cfErrorCode
    this.cfErrorDescription = params.cfErrorDescription
  }
}

const DEFAULT_API_BASE = "https://rtc.live.cloudflare.com/v1/apps"
const REQUEST_TIMEOUT_MS = 8_000

export class CloudflareRealtimeApi implements RealtimeMediaApi {
  private readonly appId: string
  private readonly appSecret: string
  private readonly apiBase: string

  constructor(config: CloudflareRealtimeConfig) {
    if (!config.appId || !config.appSecret) {
      throw new Error("CloudflareRealtimeApi requires a CF Realtime app id and secret")
    }
    this.appId = config.appId
    this.appSecret = config.appSecret
    this.apiBase = (config.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, "")
  }

  async createSession(): Promise<CreateSessionResult> {
    const body = await this.request<{
      sessionId?: string
      sessionDescription?: SessionDescription
      errorCode?: string
      errorDescription?: string
    }>("POST", `/${this.appId}/sessions/new`, undefined)
    if (!body.sessionId) {
      throw new CloudflareRealtimeError("CF session create returned no sessionId", {
        status: 502,
        code: "CF_SESSION_CREATE_FAILED",
        cfErrorCode: body.errorCode,
        cfErrorDescription: body.errorDescription,
      })
    }
    return { sessionId: body.sessionId, sessionDescription: body.sessionDescription }
  }

  async renegotiateSession(sessionId: string, sdp: SessionDescription): Promise<RenegotiateResult> {
    const body = await this.request<{ sessionDescription?: SessionDescription }>(
      "PUT",
      `/${this.appId}/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      { sessionDescription: sdp }
    )
    return { sessionDescription: body.sessionDescription }
  }

  async addLocalTracks(
    sessionId: string,
    params: { sdp: SessionDescription; tracks: LocalTrackRequest[] }
  ): Promise<TracksResult> {
    const body = await this.request<{
      requiresImmediateRenegotiation?: boolean
      tracks?: TrackResult[]
      sessionDescription?: SessionDescription
    }>("POST", `/${this.appId}/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
      sessionDescription: params.sdp,
      tracks: params.tracks,
    })
    return {
      requiresImmediateRenegotiation: body.requiresImmediateRenegotiation ?? false,
      tracks: body.tracks ?? [],
      sessionDescription: body.sessionDescription,
    }
  }

  async pullRemoteTracks(sessionId: string, params: { tracks: RemoteTrackRequest[] }): Promise<TracksResult> {
    const body = await this.request<{
      requiresImmediateRenegotiation?: boolean
      tracks?: TrackResult[]
      sessionDescription?: SessionDescription
    }>("POST", `/${this.appId}/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
      tracks: params.tracks,
    })
    return {
      requiresImmediateRenegotiation: body.requiresImmediateRenegotiation ?? false,
      tracks: body.tracks ?? [],
      sessionDescription: body.sessionDescription,
    }
  }

  async closeTracks(
    sessionId: string,
    params: { mids: string[]; force?: boolean; sdp?: SessionDescription }
  ): Promise<CloseTracksResult> {
    const body = await this.request<{ tracks?: TrackResult[] }>(
      "PUT",
      `/${this.appId}/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      {
        tracks: params.mids.map((mid) => ({ mid })),
        force: params.force ?? false,
        ...(params.sdp ? { sessionDescription: params.sdp } : {}),
      }
    )
    return { tracks: body.tracks ?? [] }
  }

  async closeSession(sessionId: string): Promise<void> {
    // CF has no session-delete verb (DELETE → 405 "reserved for future
    // WHIP/WHEP") and tracks/close REJECTS an empty track list (406 "Expecting
    // at least 1 track") — live-probe findings, 2026-07-19. The only real
    // teardown: enumerate the session's tracks via GET session state, then
    // force-close them by mid. A GET failure (410 "disconnected", 404, timeout)
    // means the PC is already gone — no media can flow, nothing to close; CF
    // reaps disconnected sessions on its own inactivity timeout.
    let state: { tracks?: Array<{ mid?: string | null }> }
    try {
      state = await this.request<{ tracks?: Array<{ mid?: string | null }> }>(
        "GET",
        `/${this.appId}/sessions/${encodeURIComponent(sessionId)}`,
        undefined
      )
    } catch {
      return
    }
    const mids = (state.tracks ?? []).map((t) => t.mid).filter((mid): mid is string => !!mid)
    if (mids.length === 0) return
    await this.request("PUT", `/${this.appId}/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
      tracks: mids.map((mid) => ({ mid })),
      force: true,
    })
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      // `undefined` body sends NO body at all: CF's sessions/new rejects a
      // present-but-empty `{}` with 400 decoding_error ("validation error:
      // sessionDescription") but accepts an absent body as a no-SDP create
      // (live-CF probe finding, 2026-07-19).
      response = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.appSecret}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError"
      throw new CloudflareRealtimeError(timedOut ? "CF request timed out" : "CF request failed", {
        status: 0,
        code: timedOut ? "CF_TIMEOUT" : "CF_NETWORK_ERROR",
      })
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new CloudflareRealtimeError(`CF request failed with ${response.status}`, {
        status: 502,
        code: "CF_HTTP_ERROR",
        cfErrorDescription: text.slice(0, 500) || undefined,
      })
    }

    return (await response.json()) as T
  }
}
