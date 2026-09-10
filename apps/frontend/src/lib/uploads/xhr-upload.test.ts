import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as diagnostics from "@/lib/connectivity-diagnostics/facade"
import { xhrUpload } from "./xhr-upload"

class FakeXhr {
  upload: { onprogress: ((event: ProgressEvent) => void) | null; onload: (() => void) | null } = {
    onprogress: null,
    onload: null,
  }
  onload: (() => void) | null = null
  onreadystatechange: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 201
  readyState = 0
  responseText = "{}"
  withCredentials = false
  open = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => this.onabort?.())
  getResponseHeader = vi.fn(() => "railway_1")
}

describe("xhrUpload connectivity phases", () => {
  let xhr: FakeXhr
  let events: Array<{ event: diagnostics.ConnectivityEvent; fields: diagnostics.DiagnosticFields }>

  beforeEach(() => {
    events = []
    xhr = new FakeXhr()
    const current = xhr
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        constructor() {
          return current
        }
      }
    )
    vi.spyOn(diagnostics, "beginConnectivityObservation").mockImplementation((fields = {}) => ({
      id: "op_test",
      record: (event, extra = {}) => {
        events.push({ event, fields: { ...fields, ...extra, operationId: "op_test" } })
      },
      stall: () => {
        const timer = setTimeout(
          () => events.push({ event: "http_stalled", fields: { ...fields, operationId: "op_test" } }),
          10
        )
        return () => clearTimeout(timer)
      },
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("should report an upload stall and later complete without imposing a transfer timeout", async () => {
    vi.useFakeTimers()
    const result = xhrUpload({
      url: "/api/workspaces/ws_secret/attachments/attach_secret/content?signature=secret",
      blob: new Blob(["payload"]),
      filename: "secret.txt",
    })

    await vi.advanceTimersByTimeAsync(diagnostics.SLOW_REQUEST_MS)
    xhr.upload.onload?.()
    xhr.readyState = XMLHttpRequest.HEADERS_RECEIVED
    xhr.onreadystatechange?.()
    xhr.onload?.()

    await expect(result).resolves.toEqual({ status: 201, body: {} })
    const base = {
      method: "POST" as const,
      route: "attachments" as const,
      transport: "xhr" as const,
      operationId: "op_test",
    }
    expect(events).toEqual([
      { event: "http_start", fields: base },
      { event: "http_stalled", fields: base },
      { event: "http_upload_complete", fields: base },
      { event: "http_headers", fields: { ...base, status: 201, correlationId: "railway_1" } },
      { event: "http_body_complete", fields: { ...base, status: 201, correlationId: "railway_1" } },
    ])
    expect(events[0]!.fields).not.toHaveProperty("url")
  })

  it("should keep a fast upload to start and upload-complete events", async () => {
    const result = xhrUpload({
      url: "/api/workspaces/ws/attachments/id/content",
      blob: new Blob(["payload"]),
      filename: "fast.txt",
    })
    xhr.upload.onload?.()
    xhr.readyState = XMLHttpRequest.HEADERS_RECEIVED
    xhr.onreadystatechange?.()
    xhr.onload?.()

    await expect(result).resolves.toEqual({ status: 201, body: {} })
    expect(events.map((entry) => entry.event)).toEqual(["http_start", "http_upload_complete"])
  })

  it("should preserve caller cancellation and classify it as an abort", async () => {
    const controller = new AbortController()
    const result = xhrUpload({
      url: "/api/workspaces/ws/attachments/id/content",
      blob: new Blob(),
      filename: "x",
      signal: controller.signal,
    })
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    const base = {
      method: "POST" as const,
      route: "attachments" as const,
      transport: "xhr" as const,
      operationId: "op_test",
    }
    expect(events).toEqual([
      { event: "http_start", fields: base },
      { event: "http_abort", fields: { ...base, reason: "abort" } },
    ])
  })
})
