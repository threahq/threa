import type { Pool } from "pg"
import { STREAM_BRIEF_MAX_CHARS } from "@threa/types"
import { streamBriefId, streamBriefRevisionId } from "../../lib/id"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { StreamBriefRepository, type BriefAuthorKind, type StreamBrief } from "./brief-repository"

/**
 * The cap is enforced here (not only in the endpoint's Zod schema) so the agent
 * tool path (roadmap 4.2) hits the same wall. Re-exported so existing importers
 * keep their `./brief-service` source; the value lives in `@threa/types` (INV-33).
 */
export { STREAM_BRIEF_MAX_CHARS }

/**
 * Threads carry no brief of their own — a thread reads and writes its root
 * stream's brief, mirroring the access rule (INV-62 thread → root).
 */
export function resolveBriefStreamId(stream: { id: string; rootStreamId: string | null }): string {
  return stream.rootStreamId ?? stream.id
}

export interface UpdateBriefParams {
  workspaceId: string
  streamId: string
  content: string
  /** The version the caller read; 0 when creating a brief that didn't exist. */
  expectedVersion: number
  updatedByKind: BriefAuthorKind
  updatedById: string
}

export type UpdateBriefResult =
  | { outcome: "updated"; brief: StreamBrief }
  /**
   * The caller's expectedVersion lost — a concurrent write moved the brief (or
   * created/left it in a state the caller didn't read). `current` is the fresh
   * row so the caller can merge and retry; `null` when no brief exists at all.
   */
  | { outcome: "version_conflict"; current: StreamBrief | null }

export class StreamBriefService {
  private pool: Pool

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  async get(params: { workspaceId: string; streamId: string }): Promise<StreamBrief | null> {
    return StreamBriefRepository.findByStreamId(this.pool, params.workspaceId, params.streamId)
  }

  /**
   * Full-replacement write with optimistic concurrency (INV-20). The brief row
   * write and its revision row commit together, so the audit trail can never
   * miss an accepted version.
   */
  async update(params: UpdateBriefParams): Promise<UpdateBriefResult> {
    const { workspaceId, streamId, content, expectedVersion, updatedByKind, updatedById } = params
    if (content.length > STREAM_BRIEF_MAX_CHARS) {
      throw new HttpError(`Brief exceeds ${STREAM_BRIEF_MAX_CHARS} characters`, {
        status: 400,
        code: "BRIEF_TOO_LONG",
        details: { maxChars: STREAM_BRIEF_MAX_CHARS },
      })
    }

    return withTransaction(this.pool, async (client) => {
      const brief =
        expectedVersion === 0
          ? await StreamBriefRepository.insertFirstVersion(client, {
              id: streamBriefId(),
              workspaceId,
              streamId,
              content,
              updatedByKind,
              updatedById,
            })
          : await StreamBriefRepository.updateAtVersion(client, {
              workspaceId,
              streamId,
              content,
              expectedVersion,
              updatedByKind,
              updatedById,
            })

      if (!brief) {
        const current = await StreamBriefRepository.findByStreamId(client, workspaceId, streamId)
        return { outcome: "version_conflict", current }
      }

      await StreamBriefRepository.insertRevision(client, {
        id: streamBriefRevisionId(),
        workspaceId,
        briefId: brief.id,
        streamId,
        version: brief.version,
        content: brief.content,
        updatedByKind,
        updatedById,
      })

      return { outcome: "updated", brief }
    })
  }
}
