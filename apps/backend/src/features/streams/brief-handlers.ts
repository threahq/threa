import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { HttpError, StreamNotFoundError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { checkStreamAccess } from "./access"
import { StreamMemberRepository } from "./member-repository"
import { resolveBriefStreamId, STREAM_BRIEF_MAX_CHARS, type StreamBriefService } from "./brief-service"

interface Dependencies {
  pool: Pool
  streamBriefService: StreamBriefService
}

const putBriefSchema = z.object({
  content: z.string().max(STREAM_BRIEF_MAX_CHARS),
  /**
   * The version the client read; 0 when no brief existed yet. Bounded to pg
   * INT4 — an unbounded value would surface as a 500 (Postgres 22003) instead
   * of a clean conflict.
   */
  version: z.number().int().min(0).max(2_147_483_647),
})

/**
 * HTTP surface for stream briefs (roadmap 4.1). Reads follow stream access
 * (public roots readable without membership, threads inherit the root —
 * INV-62); writes additionally require membership of the effective root, so a
 * workspace member who can merely *see* a public channel can't rewrite its
 * standing context. A thread's GET/PUT operates on its root's brief — threads
 * carry no brief of their own.
 */
export function createStreamBriefHandlers({ pool, streamBriefService }: Dependencies) {
  return {
    async get(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId!

      const stream = await checkStreamAccess(pool, streamId, workspaceId, userId)
      if (!stream) throw new StreamNotFoundError()

      const brief = await streamBriefService.get({ workspaceId, streamId: resolveBriefStreamId(stream) })
      res.json({ brief })
    },

    async put(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!
      const streamId = req.params.streamId!
      const { content, version } = validateRequest(putBriefSchema, req.body)

      const stream = await checkStreamAccess(pool, streamId, workspaceId, userId)
      if (!stream) throw new StreamNotFoundError()

      // A sealed stream's brief would be server-stored plaintext that the
      // enclave prompt never injects — a silent no-op attached to an E2E
      // surface. Reject until the sealed wire supports briefs (roadmap §4.1
      // deviation), consistent with E2E parity being deferred across the
      // roadmap.
      if (stream.e2eEnabled) {
        throw new HttpError("Briefs are not supported on encrypted streams", {
          status: 400,
          code: "BRIEF_E2E_UNSUPPORTED",
        })
      }

      const briefStreamId = resolveBriefStreamId(stream)
      const isMember = await StreamMemberRepository.isMember(pool, briefStreamId, userId)
      if (!isMember) {
        throw new HttpError("Only stream members can edit the brief", {
          status: 403,
          code: "BRIEF_MEMBERSHIP_REQUIRED",
        })
      }

      const result = await streamBriefService.update({
        workspaceId,
        streamId: briefStreamId,
        content,
        expectedVersion: version,
        updatedByKind: AuthorTypes.USER,
        updatedById: userId,
      })

      if (result.outcome === "version_conflict") {
        throw new HttpError("Brief was modified by someone else", {
          status: 409,
          code: "BRIEF_VERSION_CONFLICT",
          details: { current: result.current },
        })
      }

      res.json({ brief: result.brief })
    },
  }
}
