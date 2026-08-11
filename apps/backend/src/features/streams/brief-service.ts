import type { Pool, PoolClient } from "pg"
import { STREAM_BRIEF_MAX_CHARS, type BriefUpdatedEventPayload } from "@threa/types"
import { streamBriefId, streamBriefRevisionId, eventId } from "../../lib/id"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "./event-repository"
import { StreamRepository } from "./repository"
import { assertStreamWritable, type StreamWritePrincipal } from "./write-authority"
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
  /**
   * Why the brief changed. The persona `update_stream_brief` tool (roadmap 4.2)
   * supplies this; member edits via the settings editor leave it undefined and
   * the timeline row carries a null reason.
   */
  reason?: string
  principal: StreamWritePrincipal
  requestedStreamId: string
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
    return this.updateInTransaction(params, true)
  }

  async updateInternal(params: Omit<UpdateBriefParams, "principal" | "requestedStreamId">): Promise<UpdateBriefResult> {
    return this.updateInTransaction(params, false)
  }

  private async updateInTransaction(
    params: UpdateBriefParams | Omit<UpdateBriefParams, "principal" | "requestedStreamId">,
    enforceAuthority: boolean
  ): Promise<UpdateBriefResult> {
    const { workspaceId, streamId, content, expectedVersion, updatedByKind, updatedById, reason } = params

    return withTransaction(this.pool, async (client) => {
      if (enforceAuthority) {
        const request = params as UpdateBriefParams
        const authority = await assertStreamWritable(client, {
          workspaceId,
          streamId: request.requestedStreamId,
          principal: request.principal,
        })
        const effectiveRootId = authority.target.rootStreamId ?? authority.target.id
        if (effectiveRootId !== streamId) throw new HttpError("Stream not found", { status: 404, code: "NOT_FOUND" })
        const freshTarget = await StreamRepository.findById(client, request.requestedStreamId)
        if (freshTarget?.e2eEnabled) {
          throw new HttpError("Briefs are not supported on encrypted streams", {
            status: 400,
            code: "BRIEF_E2E_UNSUPPORTED",
          })
        }
      }
      if (content.length > STREAM_BRIEF_MAX_CHARS) {
        throw new HttpError(`Brief exceeds ${STREAM_BRIEF_MAX_CHARS} characters`, {
          status: 400,
          code: "BRIEF_TOO_LONG",
          details: { maxChars: STREAM_BRIEF_MAX_CHARS },
        })
      }
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

      await this.appendBriefUpdatedEvent(client, {
        workspaceId,
        streamId,
        payload: { briefId: brief.id, version: brief.version, reason: reason ?? null },
        actorId: updatedById,
        actorType: updatedByKind,
      })

      return { outcome: "updated", brief }
    })
  }

  /**
   * Append a `brief_updated` timeline broadcast row (+ its outbox row) in the
   * caller's transaction (INV-4/7), so a brief change is never silent (INV-69
   * spirit) and every member sees who changed it and why. Same envelope as the
   * memos/description capture events — the full stream event rides the outbox
   * payload so clients append it without a fetch. The row lands on the effective
   * root (`streamId` is already resolved) where the brief lives.
   */
  private async appendBriefUpdatedEvent(
    client: PoolClient,
    params: {
      workspaceId: string
      streamId: string
      payload: BriefUpdatedEventPayload
      actorId: string
      actorType: BriefAuthorKind
    }
  ): Promise<void> {
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: params.streamId,
      eventType: "brief_updated",
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
    })
    await OutboxRepository.insert(client, "stream:brief_updated", {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event,
    })
  }
}
