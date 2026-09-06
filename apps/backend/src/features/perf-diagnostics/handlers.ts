import type { Request, Response } from "express"
import { HttpError } from "@threahq/backend-common"
import { PERF_MARK_NAMES, performanceCaptureSchema } from "@threahq/types"
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
      // The frontend (Pages) deploys ahead of this backend (Railway), so a
      // client one release ahead may send mark names this build's closed set
      // doesn't know. Drop those samples instead of 400ing the whole capture —
      // unknown names never enter storage, and the session's other diagnostics
      // survive the deploy window.
      const body = req.body as { samples?: unknown }
      if (Array.isArray(body?.samples)) {
        const known = new Set<string>(PERF_MARK_NAMES)
        // Only a *string* name the set doesn't know is a deploy-window sample;
        // a non-string name is malformed and stays loud — it flows to the
        // schema and 400s as before.
        body.samples = body.samples.filter((sample) => {
          const name = (sample as { name?: unknown })?.name
          return typeof name !== "string" || known.has(name)
        })
      }
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
