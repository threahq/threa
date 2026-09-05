import { afterEach, describe, expect, it, vi } from "vitest"
import { captureException, sanitizeUrlProperties, startAnalytics, stopAnalytics, type AnalyticsClient } from "./posthog"

function createFakeClient(): AnalyticsClient {
  return {
    init: vi.fn(),
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
  } as unknown as AnalyticsClient
}

const params = { token: "tok_1", host: "https://ph.example.com", distinctId: "usr_1", workspaceId: "ws_1" }

afterEach(() => {
  stopAnalytics()
})

describe("analytics client lifecycle", () => {
  it("should init, opt in, identify and group when started", () => {
    const client = createFakeClient()

    startAnalytics(params, client)

    expect(client.init).toHaveBeenCalledWith("tok_1", {
      api_host: "https://ph.example.com",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      capture_exceptions: true,
      persistence: "localStorage+cookie",
      before_send: sanitizeUrlProperties,
    })
    expect(client.opt_in_capturing).toHaveBeenCalledWith()
    expect(client.identify).toHaveBeenCalledWith("usr_1")
    expect(client.group).toHaveBeenCalledWith("workspace", "ws_1")
  })

  it("should not capture exceptions before start", () => {
    const client = createFakeClient()

    captureException(new Error("boom"))

    expect(client.captureException).not.toHaveBeenCalled()
  })

  it("should forward exceptions with properties after start", () => {
    const client = createFakeClient()
    const error = new Error("boom")

    startAnalytics(params, client)
    captureException(error, { streamId: "stream_1" })

    expect(client.captureException).toHaveBeenCalledWith(error, { streamId: "stream_1" })
  })

  it("should reset and opt out on stop and ignore captures after", () => {
    const client = createFakeClient()

    startAnalytics(params, client)
    stopAnalytics()

    expect(client.reset).toHaveBeenCalledWith()
    expect(client.opt_out_capturing).toHaveBeenCalledWith()

    captureException(new Error("boom"))
    expect(client.captureException).not.toHaveBeenCalled()
  })

  it("should restart when the workspace changes", () => {
    const client = createFakeClient()

    startAnalytics(params, client)
    startAnalytics({ ...params, workspaceId: "ws_2" }, client)

    expect(client.reset).toHaveBeenCalledTimes(1)
    expect(client.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(client.init).toHaveBeenCalledTimes(2)
    expect(client.group).toHaveBeenNthCalledWith(2, "workspace", "ws_2")
  })

  it("should restart when the host changes", () => {
    const client = createFakeClient()

    startAnalytics(params, client)
    startAnalytics({ ...params, host: "https://us.example.com" }, client)

    expect(client.reset).toHaveBeenCalledTimes(1)
    expect(client.init).toHaveBeenCalledTimes(2)
    expect(client.init).toHaveBeenNthCalledWith(
      2,
      "tok_1",
      expect.objectContaining({ api_host: "https://us.example.com" })
    )
  })

  it("should no-op when starting again with the same target", () => {
    const client = createFakeClient()

    startAnalytics(params, client)
    startAnalytics(params, client)

    expect(client.init).toHaveBeenCalledTimes(1)
    expect(client.identify).toHaveBeenCalledTimes(1)
  })
})

describe("sanitizeUrlProperties", () => {
  function captureResult(properties: Record<string, unknown>) {
    return { event: "$pageview", properties } as unknown as Parameters<typeof sanitizeUrlProperties>[0]
  }

  it("should replace stream ids and drop the query string from the current url", () => {
    const result = sanitizeUrlProperties(
      captureResult({
        $current_url: "https://app.threa.io/w/ws_01ABC/s/stream_01XYZ?m=msg_01Q#top",
      })
    )

    expect(result?.properties.$current_url).toBe("https://app.threa.io/w/:id/s/:id")
  })

  it("should keep route segments that carry no identifier", () => {
    const result = sanitizeUrlProperties(
      captureResult({ $current_url: "https://app.threa.io/w/ws_01ABC/admin/ai-usage" })
    )

    expect(result?.properties.$current_url).toBe("https://app.threa.io/w/:id/admin/ai-usage")
  })

  it("should sanitize every url and path property it knows about", () => {
    const result = sanitizeUrlProperties(
      captureResult({
        $current_url: "https://app.threa.io/w/ws_01ABC",
        $initial_current_url: "https://app.threa.io/join/tok_01ABC",
        $session_entry_url: "https://app.threa.io/w/ws_01ABC/memos/memo_01ABC",
        $referrer: "https://mail.example.com/inbox?token=secret",
        $pathname: "/w/ws_01ABC/s/stream_01XYZ",
        $initial_pathname: "/w/ws_01ABC",
      })
    )

    expect(result?.properties).toEqual({
      $current_url: "https://app.threa.io/w/:id",
      $initial_current_url: "https://app.threa.io/join/:id",
      $session_entry_url: "https://app.threa.io/w/:id/memos/:id",
      $referrer: "https://mail.example.com/inbox",
      $pathname: "/w/:id/s/:id",
      $initial_pathname: "/w/:id",
    })
  })

  it("should keep the $direct referrer sentinel but blank an unparseable path", () => {
    const result = sanitizeUrlProperties(captureResult({ $referrer: "$direct", $current_url: "app.threa.io/w/ws_1" }))

    expect(result?.properties).toEqual({ $referrer: "$direct", $current_url: "" })
  })

  it("should leave non-url properties and events without properties alone", () => {
    const result = sanitizeUrlProperties(captureResult({ workspaceId: "ws_01ABC", $current_url: 42 }))

    expect(result?.properties).toEqual({ workspaceId: "ws_01ABC", $current_url: 42 })
    expect(sanitizeUrlProperties(null)).toBeNull()
  })
})
