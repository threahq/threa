import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import type { PerformanceCapture } from "@threahq/types"
import { HttpError } from "@threahq/backend-common"
import { setupIsolatedTestDatabase } from "./setup"
import { PerfDiagnosticsService, PerformanceCaptureRepository } from "../../src/features/perf-diagnostics"
import { userId, workspaceId } from "../../src/lib/id"

const capture: PerformanceCapture = {
  captureId: "cap_1",
  appVersion: "1.2.3",
  deviceClass: "mid",
  startedAt: "2026-08-02T09:00:00.000Z",
  samples: [{ name: "bootstrap.fetch", at: 1, value: 12 }],
}

describe("perf-capture consent", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  const ws = workspaceId()
  const user = userId()

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("perf-capture-consent"))
  })

  afterAll(async () => {
    await cleanup()
  })

  function create(optIn: boolean) {
    return new PerfDiagnosticsService(pool, async () => optIn).createCapture({
      workspaceId: ws,
      userId: user,
      capture,
      byteSize: 100,
    })
  }

  async function rejection(optIn: boolean): Promise<HttpError> {
    try {
      await create(optIn)
    } catch (err) {
      return err as HttpError
    }
    throw new Error("expected the write to be refused")
  }

  test("rejects when the preference is off", async () => {
    const err = await rejection(false)
    expect({ status: err.status, code: err.code }).toEqual({ status: 403, code: "PERF_DIAGNOSTICS_NOT_CONSENTED" })
  })

  test("no row exists after the rejection", async () => {
    const rows = await PerformanceCaptureRepository.listForUser(pool, ws, user, 100)
    expect(rows).toEqual([])
  })

  test("accepts once the user opted in", async () => {
    const { id } = await create(true)

    const rows = await PerformanceCaptureRepository.listForUser(pool, ws, user, 100)
    expect(rows.map((row) => ({ id: row.id, sampleCount: row.sampleCount }))).toEqual([{ id, sampleCount: 1 }])
  })
})
