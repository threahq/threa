import { afterEach, describe, expect, it, vi } from "vitest"
import {
  capture,
  captureException,
  sanitizeUrlProperties,
  setSessionReplay,
  startAnalytics,
  stopAnalytics,
  type AnalyticsClient,
  type AnalyticsRoot,
} from "./posthog"

function createFakeClient(): AnalyticsClient {
  return {
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    identify: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    captureException: vi.fn(),
    capture: vi.fn(),
    startSessionRecording: vi.fn(),
    stopSessionRecording: vi.fn(),
  } as unknown as AnalyticsClient
}

/**
 * posthog-js keeps one instance per name and no-ops `init` on an instance it
 * has already loaded, so the fake root hands back the same client per name.
 */
function createFakeRoot(): AnalyticsRoot & { instances: Map<string, AnalyticsClient> } {
  const instances = new Map<string, AnalyticsClient>()
  return {
    instances,
    init: vi.fn((_token: string, _config: unknown, name: string) => {
      const existing = instances.get(name)
      if (existing) return existing
      const client = createFakeClient()
      instances.set(name, client)
      return client
    }),
  } as unknown as AnalyticsRoot & { instances: Map<string, AnalyticsClient> }
}

const params = { token: "tok_1", host: "https://eu.example.com", distinctId: "usr_1", workspaceId: "ws_1" }

afterEach(() => {
  stopAnalytics()
})

describe("analytics client lifecycle", () => {
  it("should init, opt in, identify and group when started", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)

    expect(root.init).toHaveBeenCalledWith(
      "tok_1",
      {
        api_host: "https://eu.example.com",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        session_recording: {
          maskAllInputs: true,
          maskTextSelector: "*",
          blockSelector: "img, video, canvas",
        },
        enable_recording_console_log: false,
        capture_exceptions: true,
        persistence: "localStorage+cookie",
        before_send: sanitizeUrlProperties,
      },
      "threa_tok_1"
    )
    const client = root.instances.get("threa_tok_1")!
    expect(client.opt_in_capturing).toHaveBeenCalledWith()
    expect(client.identify).toHaveBeenCalledWith("usr_1")
    expect(client.group).toHaveBeenCalledWith("workspace", "ws_1")
  })

  it("should start and stop the recorder as replay consent changes", async () => {
    const root = createFakeRoot()
    await startAnalytics(params, root)
    const client = root.instances.get("threa_tok_1")!

    setSessionReplay(true)
    expect(client.startSessionRecording).toHaveBeenCalledWith()
    expect(client.stopSessionRecording).not.toHaveBeenCalled()

    setSessionReplay(false)
    expect(client.stopSessionRecording).toHaveBeenCalledWith()
  })

  it("should not record before start or after stop", async () => {
    const root = createFakeRoot()

    setSessionReplay(true)
    expect(root.init).not.toHaveBeenCalled()

    await startAnalytics(params, root)
    stopAnalytics()
    setSessionReplay(true)

    expect(root.instances.get("threa_tok_1")!.startSessionRecording).not.toHaveBeenCalled()
  })

  it("should not capture exceptions before start", async () => {
    const root = createFakeRoot()
    await startAnalytics(params, root)
    stopAnalytics()

    captureException(new Error("boom"))

    expect(root.instances.get("threa_tok_1")!.captureException).not.toHaveBeenCalled()
  })

  it("should forward exceptions with properties after start", async () => {
    const root = createFakeRoot()
    const error = new Error("boom")

    await startAnalytics(params, root)
    captureException(error, { streamId: "stream_1" })

    expect(root.instances.get("threa_tok_1")!.captureException).toHaveBeenCalledWith(error, { streamId: "stream_1" })
  })

  it("should reset and opt out on stop and ignore captures after", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    stopAnalytics()

    const client = root.instances.get("threa_tok_1")!
    expect(client.reset).toHaveBeenCalledWith()
    expect(client.opt_out_capturing).toHaveBeenCalledWith()

    captureException(new Error("boom"))
    expect(client.captureException).not.toHaveBeenCalled()
  })

  it("should re-identify on the same instance when the workspace changes", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    await startAnalytics({ ...params, workspaceId: "ws_2" }, root)

    expect(root.instances.size).toBe(1)
    const client = root.instances.get("threa_tok_1")!
    expect(client.reset).toHaveBeenCalledTimes(1)
    expect(client.group).toHaveBeenNthCalledWith(2, "workspace", "ws_2")
  })

  it("should send a workspace in another region to its own project instance", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    await startAnalytics(
      { token: "tok_2", host: "https://us.example.com", distinctId: "usr_2", workspaceId: "ws_2" },
      root
    )

    expect(root.init).toHaveBeenNthCalledWith(
      2,
      "tok_2",
      expect.objectContaining({ api_host: "https://us.example.com" }),
      "threa_tok_2"
    )
    const eu = root.instances.get("threa_tok_1")!
    const us = root.instances.get("threa_tok_2")!
    expect(eu).not.toBe(us)
    expect(eu.opt_out_capturing).toHaveBeenCalledTimes(1)
    expect(us.identify).toHaveBeenCalledWith("usr_2")

    captureException(new Error("boom"))
    expect(us.captureException).toHaveBeenCalledTimes(1)
    expect(eu.captureException).not.toHaveBeenCalled()
  })

  it("should stay inert instead of crashing the app when the SDK throws on init", async () => {
    const root = {
      init: vi.fn(() => {
        throw new Error("storage blocked")
      }),
    } as unknown as AnalyticsRoot
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(startAnalytics(params, root)).resolves.toBeUndefined()
    expect(() => captureException(new Error("boom"))).not.toThrow()
    expect(consoleError).toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it("should no-op when starting again with the same target", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    await startAnalytics(params, root)

    expect(root.init).toHaveBeenCalledTimes(1)
    expect(root.instances.get("threa_tok_1")!.identify).toHaveBeenCalledTimes(1)
  })

  it("should not arm capture when consent is withdrawn while the sdk is still loading", async () => {
    const root = createFakeRoot()
    let deliver: (value: AnalyticsRoot) => void = () => {}
    const pending = new Promise<AnalyticsRoot>((resolve) => {
      deliver = resolve
    })

    const start = startAnalytics(params, pending)
    stopAnalytics()
    deliver(root)
    await start

    expect(root.init).not.toHaveBeenCalled()
    capture("event_1")
    expect(root.instances.size).toBe(0)
  })

  it("should not throw when capturing before analytics starts", async () => {
    expect(() => capture("event_1", { foo: "bar" })).not.toThrow()
  })

  it("should forward the event name and properties to the client after startAnalytics", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    capture("event_1", { foo: "bar" })

    expect(root.instances.get("threa_tok_1")!.capture).toHaveBeenCalledWith("event_1", { foo: "bar" })
  })

  it("should capture nothing after stopAnalytics", async () => {
    const root = createFakeRoot()

    await startAnalytics(params, root)
    stopAnalytics()
    capture("event_1", { foo: "bar" })

    expect(root.instances.get("threa_tok_1")!.capture).not.toHaveBeenCalled()
  })
})

describe("sanitizeUrlProperties", () => {
  function captureResult(event: Record<string, unknown>) {
    return event as unknown as Parameters<typeof sanitizeUrlProperties>[0]
  }

  it("should replace stream ids and drop the query string from the current url", () => {
    const result = sanitizeUrlProperties(
      captureResult({
        properties: { $current_url: "https://app.threa.io/w/ws_01ABC/s/stream_01XYZ?m=msg_01Q#top" },
      })
    )

    expect(result?.properties.$current_url).toBe("https://app.threa.io/w/:id/s/:id")
  })

  it("should keep route segments that carry no identifier", () => {
    const result = sanitizeUrlProperties(
      captureResult({ properties: { $current_url: "https://app.threa.io/w/ws_01ABC/admin/ai-usage" } })
    )

    expect(result?.properties.$current_url).toBe("https://app.threa.io/w/:id/admin/ai-usage")
  })

  it("should sanitize every url and path property whatever posthog prefixes it with", () => {
    const result = sanitizeUrlProperties(
      captureResult({
        properties: {
          $current_url: "https://app.threa.io/w/ws_01ABC",
          $initial_current_url: "https://app.threa.io/join/tok_01ABC",
          $session_entry_url: "https://app.threa.io/w/ws_01ABC/memos/memo_01ABC",
          $referrer: "https://mail.example.com/inbox?token=secret",
          $session_entry_referrer: "https://mail.example.com/inbox?token=secret",
          $pathname: "/w/ws_01ABC/s/stream_01XYZ",
          $initial_pathname: "/w/ws_01ABC",
          $session_entry_pathname: "/w/ws_01ABC/s/stream_01XYZ",
        },
      })
    )

    expect(result?.properties).toEqual({
      $current_url: "https://app.threa.io/w/:id",
      $initial_current_url: "https://app.threa.io/join/:id",
      $session_entry_url: "https://app.threa.io/w/:id/memos/:id",
      $referrer: "https://mail.example.com/inbox",
      $session_entry_referrer: "https://mail.example.com/inbox",
      $pathname: "/w/:id/s/:id",
      $initial_pathname: "/w/:id",
      $session_entry_pathname: "/w/:id/s/:id",
    })
  })

  it("should sanitize the person properties posthog sets alongside the event", () => {
    const result = sanitizeUrlProperties(
      captureResult({
        properties: {},
        $set: { $current_url: "https://app.threa.io/w/ws_01ABC/s/stream_01XYZ?m=msg_01Q" },
        $set_once: {
          $initial_current_url: "https://app.threa.io/w/ws_01ABC/s/stream_01XYZ?m=msg_01Q",
          $initial_pathname: "/w/ws_01ABC/s/stream_01XYZ",
          $initial_host: "app.threa.io",
        },
      })
    )

    expect(result?.$set).toEqual({ $current_url: "https://app.threa.io/w/:id/s/:id" })
    expect(result?.$set_once).toEqual({
      $initial_current_url: "https://app.threa.io/w/:id/s/:id",
      $initial_pathname: "/w/:id/s/:id",
      $initial_host: "app.threa.io",
    })
  })

  it("should keep the $direct referrer sentinel but blank an unparseable path", () => {
    const result = sanitizeUrlProperties(
      captureResult({ properties: { $referrer: "$direct", $current_url: "app.threa.io/w/ws_1" } })
    )

    expect(result?.properties).toEqual({ $referrer: "$direct", $current_url: "" })
  })

  it("should leave non-url properties and events without properties alone", () => {
    const result = sanitizeUrlProperties(captureResult({ properties: { workspaceId: "ws_01ABC", $current_url: 42 } }))

    expect(result?.properties).toEqual({ workspaceId: "ws_01ABC", $current_url: 42 })
    expect(sanitizeUrlProperties(null)).toBeNull()
  })
})
