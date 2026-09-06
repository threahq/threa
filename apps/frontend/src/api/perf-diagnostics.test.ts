import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { PerformanceCapture } from "@threahq/types"
import { sendPerfCapture } from "./perf-diagnostics"
import { ApiError } from "./client"

const originalFetch = globalThis.fetch

const capture: PerformanceCapture = {
  captureId: "cap_1",
  appVersion: "1.2.3",
  deviceClass: "mid",
  startedAt: "2026-08-02T09:00:00.000Z",
  samples: [{ name: "bootstrap.fetch", at: 1, value: 12 }],
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe("sendPerfCapture", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("posts the capture to the workspace's endpoint", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(mockResponse(201, { id: "perfcap_1" }))

    const result = await sendPerfCapture("ws_1", capture)

    const [path, init] = vi.mocked(globalThis.fetch).mock.calls[0]
    expect({
      path,
      method: (init as RequestInit).method,
      body: JSON.parse((init as RequestInit).body as string),
      result,
    }).toEqual({
      path: "/api/workspaces/ws_1/perf-captures",
      method: "POST",
      body: capture,
      result: { id: "perfcap_1" },
    })
  })

  it("surfaces a 403 as a typed error rather than dropping it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockResponse(403, {
        error: "Performance diagnostics are not enabled for this user",
        code: "PERF_DIAGNOSTICS_NOT_CONSENTED",
      })
    )

    const err = await sendPerfCapture("ws_1", capture).catch((error: unknown) => error)

    expect(ApiError.isApiError(err) ? { status: err.status, code: err.code } : err).toEqual({
      status: 403,
      code: "PERF_DIAGNOSTICS_NOT_CONSENTED",
    })
  })
})
