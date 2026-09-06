import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fetchAttachmentBytes } from "./attachments"
import { ThreaApiError, ThreaClient } from "./client"
import { DelegationClient } from "./delegation-client"

const fetchSpy = spyOn(globalThis, "fetch")

afterEach(() => fetchSpy.mockReset())

/** 200 whose body never produces bytes and errors when the request aborts — a stalled server/proxy after headers. */
function stalledResponse(init: RequestInit | undefined): Response {
  const signal = init?.signal as AbortSignal | undefined
  const stalled = new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
    },
  })
  return new Response(stalled, { status: 200, headers: { "content-type": "application/json" } })
}

// The 2026-08-10 incident: bodies that stalled after headers hung the channel's
// request forever, the MCP server went unresponsive, and Claude Code
// SIGINT-restarted it, failing in-flight invocations as "channel shut down".
// Every HTTP body read must reject at the timeout instead.
const stalledFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
  stalledResponse(init)) as unknown as typeof fetch

describe("stalled response bodies reject at the fetch timeout", () => {
  it("ThreaClient.request", async () => {
    fetchSpy.mockImplementation(stalledFetch)
    const client = new ThreaClient({
      baseUrl: "https://example.test",
      workspaceId: "ws_1",
      apiKey: "key",
      fetchTimeoutMs: 25,
    })
    await expect(client.getMe()).rejects.toThrow()
  })

  it("DelegationClient.request", async () => {
    fetchSpy.mockImplementation(stalledFetch)
    const client = new DelegationClient({
      baseUrl: "https://example.test",
      workspaceId: "ws_1",
      apiKey: "key",
      fetchTimeoutMs: 25,
    })
    await expect(client.get("dlg_1")).rejects.toThrow()
  })

  it("fetchAttachmentBytes (pre-signed download)", async () => {
    fetchSpy.mockImplementation(stalledFetch)
    await expect(fetchAttachmentBytes("https://storage.example.test/blob", 25)).rejects.toThrow()
  })
})

function jsonFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

describe("claim retry hints", () => {
  const client = new ThreaClient({ baseUrl: "https://example.test", workspaceId: "ws_1", apiKey: "key" })

  for (const [headers, expected] of [
    [{ "Retry-After": "12" }, 12_000],
    [{ "RateLimit-Reset": "27" }, 27_000],
    [{ "Retry-After": "12", "RateLimit-Reset": "27" }, 12_000],
    [{ "Retry-After": "invalid", "RateLimit-Reset": "27" }, 27_000],
    [{ "RateLimit-Reset": "invalid" }, undefined],
  ] as const) {
    it(`should preserve the retry delay from ${JSON.stringify(headers)}`, async () => {
      fetchSpy.mockImplementation((async () => new Response("", { status: 429, headers })) as unknown as typeof fetch)
      const error = await client.claim({}).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(ThreaApiError)
      expect(error).toMatchObject({ status: 429, retryAfterMs: expected })
    })
  }

  it("should interpret an HTTP-date Retry-After relative to the response time", async () => {
    const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-06T16:48:58Z"))
    try {
      fetchSpy.mockImplementation(
        (async () =>
          new Response("", {
            status: 503,
            headers: { "Retry-After": "Sun, 06 Sep 2026 16:49:38 GMT" },
          })) as unknown as typeof fetch
      )
      const error = await client.claim({}).catch((error: unknown) => error)
      expect(error).toMatchObject({ status: 503, retryAfterMs: 40_000 })
    } finally {
      now.mockRestore()
    }
  })
})

describe("ThreaClient.sendMessage", () => {
  const client = new ThreaClient({ baseUrl: "https://example.test", workspaceId: "ws_1", apiKey: "key" })

  it("returns the sent message's id", async () => {
    fetchSpy.mockImplementation(jsonFetch({ data: { id: "msg_1", streamId: "stream_1" }, slots: {} }))
    expect(await client.sendMessage("stream_1", { content: "hi" })).toEqual({ id: "msg_1" })
  })

  it("throws when the response carries no usable message id", async () => {
    // The response is parsed, never validated, so a truthy non-string would be
    // returned as an id and reach harnessd as a `--anchor` argument.
    for (const id of [undefined, "", 123, { id: "msg_1" }]) {
      fetchSpy.mockImplementation(jsonFetch({ data: { id }, slots: {} }))
      await expect(client.sendMessage("stream_1", { content: "hi" })).rejects.toThrow(/no message id/)
    }
  })
})
