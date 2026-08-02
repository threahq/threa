import type { Request, Response } from "express"
import { HttpError } from "@threa/backend-common"
import { performanceCaptureSchema } from "@threa/types"
import { validateRequest } from "../../lib/validation"
import type { PerfDiagnosticsService } from "./service"

/**
 * Hard ceiling on one stored capture, above every schema-valid payload — a
 * backstop for schema drift, not a limit a legitimate client reaches.
 */
export const PERF_CAPTURE_MAX_BYTES = 512_000

interface Dependencies {
  perfDiagnosticsService: PerfDiagnosticsService
}

export function createPerfDiagnosticsHandlers({ perfDiagnosticsService }: Dependencies) {
  return {
    async create(req: Request, res: Response) {
      const capture = validateRequest(performanceCaptureSchema, req.body)

      const byteSize = Buffer.byteLength(JSON.stringify(capture), "utf8")
      if (byteSize > PERF_CAPTURE_MAX_BYTES) {
        throw new HttpError("Performance capture is too large", {
          status: 413,
          code: "PERF_CAPTURE_TOO_LARGE",
        })
      }

      const { id } = await perfDiagnosticsService.createCapture({
        workspaceId: req.workspaceId!,
        userId: req.user!.id,
        workosUserId: req.workosUserId!,
        capture,
        byteSize,
      })

      res.status(201).json({ id })
    },
  }
}
