import type { Pool } from "pg"
import { HttpError } from "@threa/backend-common"
import type { FeatureFlagValue, PerformanceCapture } from "@threa/types"
import { withTransaction } from "../../db"
import { perfCaptureId } from "../../lib/id"
import { PerformanceCaptureRepository } from "./repository"

/**
 * The workspace+user resolution of the `perfDiagnostics` flag. Injected rather
 * than read through the feature-flags feature's internals so this feature stays
 * constructed once with its collaborators (INV-13) and never deep-imports
 * another feature (INV-52) — the same shape as `GetComposeTraceMode`.
 */
export type GetPerfDiagnosticsMode = (
  workspaceId: string,
  workosUserId: string
) => Promise<FeatureFlagValue<"perfDiagnostics">>

/** The user's own `performanceDiagnosticsOptIn` preference, read server-side. */
export type GetPerfDiagnosticsOptIn = (workspaceId: string, userId: string) => Promise<boolean>

export interface CreatePerformanceCaptureInput {
  workspaceId: string
  /** Regional user id — what the row is keyed on. */
  userId: string
  /** WorkOS id — what feature-flag overrides are keyed on. */
  workosUserId: string
  capture: PerformanceCapture
  byteSize: number
}

/**
 * Stores one uploaded performance capture. Consent is two independent facts and
 * both are re-resolved here, never trusted from the client: the workspace/user
 * flag decides whether the feature is offered at all, and the user's preference
 * is the consent itself. Either being off is a 403, not a silent drop (INV-11).
 */
export class PerfDiagnosticsService {
  constructor(
    private readonly pool: Pool,
    private readonly getMode: GetPerfDiagnosticsMode,
    private readonly getOptIn: GetPerfDiagnosticsOptIn
  ) {}

  async createCapture(input: CreatePerformanceCaptureInput): Promise<{ id: string }> {
    const [mode, optIn] = await Promise.all([
      this.getMode(input.workspaceId, input.workosUserId),
      this.getOptIn(input.workspaceId, input.userId),
    ])

    if (mode !== "available" || !optIn) {
      throw new HttpError("Performance diagnostics are not enabled for this user", {
        status: 403,
        code: "PERF_DIAGNOSTICS_NOT_CONSENTED",
      })
    }

    const id = perfCaptureId()
    await withTransaction(this.pool, async (client) => {
      await PerformanceCaptureRepository.insert(client, {
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
    })

    return { id }
  }
}
