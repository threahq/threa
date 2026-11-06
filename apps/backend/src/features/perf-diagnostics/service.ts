import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import type { PerformanceCapture } from "@threahq/types"
import { perfCaptureId } from "../../lib/id"
import { PerformanceCaptureRepository } from "./repository"

/** The user's own `performanceDiagnosticsOptIn` preference, read server-side. */
export type GetPerfDiagnosticsOptIn = (workspaceId: string, userId: string) => Promise<boolean>

export interface CreatePerformanceCaptureInput {
  workspaceId: string
  /** Regional user id — what the row is keyed on. */
  userId: string
  capture: PerformanceCapture
  byteSize: number
}

/**
 * Stores one uploaded performance capture. The user's preference is the
 * consent, re-read here and never trusted from the client; without it the
 * upload is a 403, not a silent drop (INV-11).
 */
export class PerfDiagnosticsService {
  constructor(
    private readonly pool: Pool,
    private readonly getOptIn: GetPerfDiagnosticsOptIn
  ) {}

  async createCapture(input: CreatePerformanceCaptureInput): Promise<{ id: string }> {
    if (!(await this.getOptIn(input.workspaceId, input.userId))) {
      throw new HttpError("Performance diagnostics are not enabled for this user", {
        status: 403,
        code: "PERF_DIAGNOSTICS_NOT_CONSENTED",
      })
    }

    const id = perfCaptureId()
    await PerformanceCaptureRepository.insert(this.pool, {
      id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      captureId: input.capture.captureId,
      appVersion: input.capture.appVersion,
      deviceClass: input.capture.deviceClass,
      startedAt: input.capture.startedAt,
      sampleCount: input.capture.samples.length,
      byteSize: input.byteSize,
      samples: input.capture.samples,
    })

    return { id }
  }
}
