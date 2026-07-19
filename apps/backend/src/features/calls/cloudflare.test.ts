import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { CloudflareRealtimeApi, CloudflareRealtimeError } from "./cloudflare"

const CONFIG = { appId: "app_1", appSecret: "secret_1", enabled: true }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(((url: string, init: RequestInit) =>
    impl(url, init)) as typeof fetch)
}

function lastCall(f: ReturnType<typeof stubFetch>) {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as [string, RequestInit]
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined }
}

describe("CloudflareRealtimeApi.createSession", () => {
  afterEach(() => mock.restore())

  it("POSTs to sessions/new with the bearer secret and returns the session", async () => {
    const f = stubFetch(async () =>
      jsonResponse({ sessionId: "sess_1", sessionDescription: { type: "answer", sdp: "s" } })
    )
    const api = new CloudflareRealtimeApi(CONFIG)

    const result = await api.createSession()

    const { url, init } = lastCall(f)
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/new")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret_1")
    expect(result).toEqual({ sessionId: "sess_1", sessionDescription: { type: "answer", sdp: "s" } })
  })

  it("honors the apiBase override", async () => {
    const f = stubFetch(async () => jsonResponse({ sessionId: "sess_1" }))
    const api = new CloudflareRealtimeApi({ ...CONFIG, apiBase: "https://cf.test/v1/apps" })

    await api.createSession()

    expect(lastCall(f).url).toBe("https://cf.test/v1/apps/app_1/sessions/new")
  })

  it("throws a typed error when CF returns no sessionId", async () => {
    stubFetch(async () => jsonResponse({ errorCode: "boom", errorDescription: "no session" }))
    const api = new CloudflareRealtimeApi(CONFIG)

    const promise = api.createSession()
    await expect(promise).rejects.toBeInstanceOf(CloudflareRealtimeError)
    await expect(promise).rejects.toMatchObject({ code: "CF_SESSION_CREATE_FAILED", cfErrorCode: "boom" })
  })
})

describe("CloudflareRealtimeApi tracks", () => {
  afterEach(() => mock.restore())

  it("addLocalTracks posts sdp + local tracks to tracks/new", async () => {
    const f = stubFetch(async () =>
      jsonResponse({ requiresImmediateRenegotiation: true, tracks: [{ mid: "0", trackName: "mic" }] })
    )
    const api = new CloudflareRealtimeApi(CONFIG)

    const result = await api.addLocalTracks("sess_1", {
      sdp: { type: "offer", sdp: "o" },
      tracks: [{ location: "local", trackName: "mic", mid: "0" }],
    })

    const { url, body } = lastCall(f)
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/sess_1/tracks/new")
    expect(body).toEqual({
      sessionDescription: { type: "offer", sdp: "o" },
      tracks: [{ location: "local", trackName: "mic", mid: "0" }],
    })
    expect(result.requiresImmediateRenegotiation).toBe(true)
  })

  it("pullRemoteTracks posts only remote tracks (no sdp)", async () => {
    const f = stubFetch(async () =>
      jsonResponse({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "o" },
        tracks: [],
      })
    )
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.pullRemoteTracks("sess_1", {
      tracks: [{ location: "remote", sessionId: "sess_peer", trackName: "cam" }],
    })

    expect(lastCall(f).body).toEqual({ tracks: [{ location: "remote", sessionId: "sess_peer", trackName: "cam" }] })
  })

  it("renegotiateSession PUTs the sdp", async () => {
    const f = stubFetch(async () => jsonResponse({}))
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.renegotiateSession("sess_1", { type: "answer", sdp: "a" })

    const { url, init, body } = lastCall(f)
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/sess_1/renegotiate")
    expect(init.method).toBe("PUT")
    expect(body).toEqual({ sessionDescription: { type: "answer", sdp: "a" } })
  })

  it("closeTracks PUTs the mids to tracks/close", async () => {
    const f = stubFetch(async () => jsonResponse({ tracks: [] }))
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.closeTracks("sess_1", { mids: ["0", "1"], force: true })

    const { url, init, body } = lastCall(f)
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/sess_1/tracks/close")
    expect(init.method).toBe("PUT")
    expect(body).toEqual({ tracks: [{ mid: "0" }, { mid: "1" }], force: true })
  })

  it("closeSession enumerates the session's tracks via state GET, then force-closes them by mid", async () => {
    const f = stubFetch(async (url, init) => {
      if (init.method === "GET") {
        return jsonResponse({
          tracks: [
            { location: "local", mid: "0" },
            { location: "remote", mid: "2" },
          ],
        })
      }
      return jsonResponse({ tracks: [] })
    })
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.closeSession("sess_1")

    const stateCall = f.mock.calls[0] as [string, RequestInit]
    expect(stateCall[0]).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/sess_1")
    expect(stateCall[1].method).toBe("GET")
    const { url, init, body } = lastCall(f)
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/apps/app_1/sessions/sess_1/tracks/close")
    expect(init.method).toBe("PUT")
    expect(body).toEqual({ tracks: [{ mid: "0" }, { mid: "2" }], force: true })
  })

  it("closeSession returns quietly when the state GET fails (session already dead) — no empty close", async () => {
    const f = stubFetch(async (url, init) => {
      if (init.method === "GET") {
        return jsonResponse({ errorCode: "session_error", errorDescription: "disconnected" }, 410)
      }
      return jsonResponse({ tracks: [] })
    })
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.closeSession("sess_1")

    expect(f.mock.calls).toHaveLength(1)
  })

  it("closeSession skips the close when the session has no tracks (CF rejects an empty tracks/close)", async () => {
    const f = stubFetch(async () => jsonResponse({ tracks: [] }))
    const api = new CloudflareRealtimeApi(CONFIG)

    await api.closeSession("sess_1")

    expect(f.mock.calls).toHaveLength(1)
  })
})

describe("CloudflareRealtimeApi error handling", () => {
  afterEach(() => mock.restore())

  it("maps a non-2xx response to a typed CF_HTTP_ERROR", async () => {
    stubFetch(async () => new Response("upstream boom", { status: 500 }))
    const api = new CloudflareRealtimeApi(CONFIG)

    const promise = api.createSession()
    await expect(promise).rejects.toBeInstanceOf(CloudflareRealtimeError)
    await expect(promise).rejects.toMatchObject({ code: "CF_HTTP_ERROR", status: 502 })
  })

  it("maps an aborted fetch to a typed CF_TIMEOUT", async () => {
    stubFetch(async () => {
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    })
    const api = new CloudflareRealtimeApi(CONFIG)

    const promise = api.createSession()
    await expect(promise).rejects.toMatchObject({ code: "CF_TIMEOUT", status: 0 })
  })

  it("maps a network failure to a typed CF_NETWORK_ERROR", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED")
    })
    const api = new CloudflareRealtimeApi(CONFIG)

    await expect(api.createSession()).rejects.toMatchObject({ code: "CF_NETWORK_ERROR", status: 0 })
  })
})
