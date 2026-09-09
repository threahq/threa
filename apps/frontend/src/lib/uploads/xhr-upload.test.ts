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

    await vi.advanceTimersByTimeAsync(10)
    xhr.upload.onload?.()
    xhr.readyState = XMLHttpRequest.HEADERS_RECEIVED
    xhr.onreadystatechange?.()
    xhr.onload?.()

    await expect(result).resolves.toEqual({ status: 201, body: {} })
    expect(events.map(({ event }) => event)).toEqual([
      "http_start",
      "http_stalled",
      "http_upload_complete",
      "http_headers",
      "http_body_complete",
    ])
    expect(events[0]!.fields).toMatchObject({ method: "POST", route: "attachments", transport: "xhr" })
    expect(events[0]!.fields).not.toHaveProperty("url")
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
    expect(events.map(({ event }) => event)).toEqual(["http_start", "http_abort"])
  })
})
