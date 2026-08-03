import { describe, expect, it } from "bun:test"
import type { Request, Response } from "express"
import { HttpError } from "@threa/backend-common"
import { PERF_CAPTURE_MAX_SAMPLES } from "@threa/types"
import { createPerfDiagnosticsHandlers, PERF_CAPTURE_MAX_BYTES } from "./handlers"
import type { PerfDiagnosticsService } from "./service"

const captured: unknown[] = []
const service = {
  createCapture: async (args: { capture: unknown }) => {
    captured.push(args.capture)
    return { id: "perfcap_x" }
  },
} as unknown as PerfDiagnosticsService

const handlers = createPerfDiagnosticsHandlers({ perfDiagnosticsService: service })

function request(body: unknown): Request {
  return { body, workspaceId: "ws_1", user: { id: "usr_1" }, workosUserId: "wos_1" } as unknown as Request
}

function response(): Response & { statusCode: number | null; body: unknown } {
  const res = {
    statusCode: null as number | null,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res as unknown as Response & { statusCode: number | null; body: unknown }
}

const validCapture = {
  captureId: "cap_1",
  appVersion: "1.2.3",
  deviceClass: "mid",
  startedAt: "2026-08-02T09:00:00.000Z",
  samples: [{ name: "bootstrap.fetch", at: 1, value: 12 }],
}

async function failure(body: unknown): Promise<HttpError> {
  try {
    await handlers.create(request(body), response())
  } catch (err) {
    return err as HttpError
  }
  throw new Error("expected the handler to reject")
}

describe("perf-capture create handler", () => {
  it("stores a valid capture", async () => {
    const res = response()
    await handlers.create(request(validCapture), res)
    expect({ statusCode: res.statusCode, body: res.body }).toEqual({ statusCode: 201, body: { id: "perfcap_x" } })
  })

  it("drops samples with unknown mark names and stores the rest", async () => {
    // A Pages deploy runs ahead of Railway, so a client one release ahead may
    // send names this build's closed set doesn't know — the capture survives,
    // the unknown samples never enter storage.
    const res = response()
    await handlers.create(
      request({
        ...validCapture,
        samples: [
          { name: "bootstrap.fetch", at: 1, value: 12 },
          { name: "future.unknownMark", at: 2, value: 3 },
        ],
      }),
      res
    )
    expect({
      statusCode: res.statusCode,
      samples: (captured.at(-1) as { samples: { name: string }[] }).samples.map((s) => s.name),
    }).toEqual({ statusCode: 201, samples: ["bootstrap.fetch"] })
  })

  it("rejects a capture whose samples are all unknown as empty-invalid only if the schema requires samples", async () => {
    // All-unknown samples degrade to an empty samples array; the schema decides
    // whether that is acceptable — this pins the handler never 400s on names.
    const res = response()
    await handlers.create(request({ ...validCapture, samples: [{ name: "future.unknownMark", at: 2, value: 3 }] }), res)
    expect(res.statusCode).toBe(201)
  })

  it("a malformed non-string sample name still 400s", async () => {
    const err = await failure({ ...validCapture, samples: [{ name: 42, at: 1, value: 12 }] })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("a missing sample name still 400s", async () => {
    const err = await failure({ ...validCapture, samples: [{ at: 1, value: 12 }] })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("rejects a capture over the sample cap", async () => {
    const samples = Array.from({ length: PERF_CAPTURE_MAX_SAMPLES + 1 }, (_, i) => ({ name: "liveQuery.rerun", at: i }))
    const err = await failure({ ...validCapture, samples })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("rejects unknown top-level fields", async () => {
    const err = await failure({ ...validCapture, streamId: "stream_1" })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("rejects an over-long appVersion", async () => {
    const err = await failure({ ...validCapture, appVersion: "v".repeat(65) })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("rejects a captureId outside the generated shape", async () => {
    const err = await failure({ ...validCapture, captureId: "stream_1/../secret" })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("rejects a non-timestamp startedAt", async () => {
    const err = await failure({ ...validCapture, startedAt: "soon" })
    expect({ status: err.status, code: err.code }).toEqual({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("accepts the largest schema-valid payload, so the byte ceiling is only a backstop", async () => {
    const samples = Array.from({ length: PERF_CAPTURE_MAX_SAMPLES }, () => ({
      name: "observer.longTask",
      at: 1.2345678901234567e300,
      value: 1.2345678901234567e300,
      count: 1.2345678901234567e300,
    }))
    const body = { ...validCapture, captureId: `cap_${"A".repeat(60)}`, appVersion: "v".repeat(64), samples }
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThan(PERF_CAPTURE_MAX_BYTES)

    const res = response()
    await handlers.create(request(body), res)
    expect(res.statusCode).toBe(201)
  })
})
