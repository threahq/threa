import type { Pool, PoolClient } from "pg"
import type { Draft as DraftView, JSONContent, DraftCommand } from "@threa/types"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { draftId } from "../../lib/id"
import { DraftsRepository, type Draft } from "./repository"
import { toDraftView } from "./view"

interface DraftsServiceDeps {
  pool: Pool
}

export interface UpsertDraftParams {
  workspaceId: string
  userId: string
  id: string
  scope: string
  rootStreamId: string | null
  expectedVersion: number
  writeId: string
  clientUpdatedAt: Date
  contentJson: JSONContent | null
  contentMarkdown: string | null
  attachmentIds: string[]
  command: DraftCommand | null
  contextRefs: Record<string, unknown>[] | null
  ciphertext: string | null
  envelope: unknown | null
  e2eVersion: number | null
}

export interface UpsertDraftResult {
  draft: DraftView
  split: boolean
  originalId?: string
}

export interface ResolveDraftParams {
  workspaceId: string
  userId: string
  id: string
  expectedVersion: number
}

export interface DeleteDraftParams {
  workspaceId: string
  userId: string
  id: string
}

/**
 * Drafts service — centralized, local-first composer payloads that roam across
 * the author's devices. Drafts are private to their author (INV-8/50), never
 * timeline-broadcast, delivered only to the owner's `user:{userId}` room.
 *
 * Concurrency is optimistic on an integer `version`, the same primitive
 * `scheduled_messages` uses — but on a version mismatch this service SPLITS
 * (keeps the existing row, mints a new draft for the incoming content) instead
 * of rejecting with a 409. The cardinal rule: never overwrite. Duplicated
 * drafts are acceptable; lost drafts are not.
 */
export class DraftsService {
  private readonly pool: Pool

  constructor(deps: DraftsServiceDeps) {
    this.pool = deps.pool
  }

  /**
   * Idempotent, split-on-drift upsert (Decision 4 / plan §"drift/split
   * protocol"). One transaction, locking the row by id so concurrent pushes
   * serialize:
   *
   *  a. `insertIfAbsent` — brand-new id lands at version 1. Done, no split.
   *  b. else lock the existing row. If its `last_client_write_id` matches the
   *     incoming `writeId`, this is a lost-ack retry of an already-accepted
   *     write — return the row unchanged, no split.
   *  c. else CAS-update on `expectedVersion`. Match → version+1, no split.
   *  d. else (version drift, or the original id is a resolved tombstone) →
   *     SPLIT: leave the existing row untouched, insert a fresh `draft_` id
   *     carrying the incoming content at version 1. Return `originalId` so the
   *     client migrates its local state to the new id.
   *
   * Every branch that changes state writes a `draft:upserted` outbox row so the
   * author's other devices converge (INV-4/7, INV-53).
   */
  async upsert(params: UpsertDraftParams): Promise<UpsertDraftResult> {
    return withTransaction(this.pool, async (client) => {
      const insertParams = {
        workspaceId: params.workspaceId,
        userId: params.userId,
        scope: params.scope,
        rootStreamId: params.rootStreamId,
        contentJson: params.contentJson,
        contentMarkdown: params.contentMarkdown,
        attachmentIds: params.attachmentIds,
        command: params.command,
        contextRefs: params.contextRefs,
        ciphertext: params.ciphertext,
        envelope: params.envelope,
        e2eVersion: params.e2eVersion,
        clientUpdatedAt: params.clientUpdatedAt,
        lastClientWriteId: params.writeId,
      }

      // (a) Brand-new id.
      const inserted = await DraftsRepository.insertIfAbsent(client, { id: params.id, ...insertParams })
      if (inserted) {
        return this.finishUpsert(client, inserted, false)
      }

      // The id already exists — lock it and decide update vs split.
      const existing = await DraftsRepository.findByIdForUpdate(client, params.workspaceId, params.userId, params.id)

      // (b) Lost-ack retry of a write we already accepted — return as-is. Gated
      // on a LIVE row: if the draft was resolved (tombstoned) after this write
      // landed, the writeId still matches but the row is gone, so we must not
      // hand back a deleted draft as live (it would contradict the draft:deleted
      // already on the wire). A tombstoned match falls through to the split.
      if (existing && !existing.deletedAt && existing.lastClientWriteId === params.writeId) {
        return { draft: toDraftView(existing), split: false }
      }

      // (c) Happy path — CAS update on the version the edit was based on. The
      // CAS guards `deleted_at IS NULL`, so a tombstoned row returns null here
      // and drops to the split.
      if (existing && !existing.deletedAt) {
        const updated = await DraftsRepository.casUpdate(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          id: params.id,
          expectedVersion: params.expectedVersion,
          rootStreamId: params.rootStreamId,
          contentJson: params.contentJson,
          contentMarkdown: params.contentMarkdown,
          attachmentIds: params.attachmentIds,
          command: params.command,
          contextRefs: params.contextRefs,
          ciphertext: params.ciphertext,
          envelope: params.envelope,
          e2eVersion: params.e2eVersion,
          clientUpdatedAt: params.clientUpdatedAt,
          lastClientWriteId: params.writeId,
        })
        if (updated) {
          return this.finishUpsert(client, updated, false)
        }
      }

      // (d) Drift (or a tombstoned original) → split into a fresh draft.
      const newRow = await DraftsRepository.insertIfAbsent(client, { id: draftId(), ...insertParams })
      if (!newRow) {
        // The split id is a freshly minted ULID, so the insert lands unless the
        // id space collided — fail loud (INV-11) rather than feed null forward.
        throw new Error("draft split insert returned no row (id collision)")
      }
      const result = await this.finishUpsert(client, newRow, true)
      return { ...result, originalId: params.id }
    })
  }

  /**
   * Clear a draft on successful send (resolve-on-send). CAS-guarded by
   * `expectedVersion` so a copy that drifted since the send started survives as
   * a stash entry instead of being collaterally deleted. On a match, soft-delete
   * and emit `draft:deleted`; on drift, leave the row and report `resolved:
   * false`.
   */
  async resolve(params: ResolveDraftParams): Promise<{ resolved: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const deleted = await DraftsRepository.softDeleteCas(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        id: params.id,
        expectedVersion: params.expectedVersion,
      })
      if (!deleted) {
        // Either drifted (version moved on) or already gone — keep the row.
        return { resolved: false }
      }
      await this.publishDelete(client, params.workspaceId, params.userId, params.id)
      return { resolved: true }
    })
  }

  /**
   * Explicit discard — the user threw the draft away, so drift doesn't matter.
   * Unconditional soft-delete, idempotent on an already-gone row. Emits
   * `draft:deleted` so other devices drop it too.
   */
  async delete(params: DeleteDraftParams): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const deleted = await DraftsRepository.softDelete(client, params.workspaceId, params.userId, params.id)
      if (deleted) {
        await this.publishDelete(client, params.workspaceId, params.userId, params.id)
      }
    })
  }

  /** Bootstrap seed for the author's devices (INV-53) — every live draft. */
  async list(params: { workspaceId: string; userId: string }): Promise<DraftView[]> {
    const rows = await DraftsRepository.listByUser(this.pool, params.workspaceId, params.userId)
    return rows.map(toDraftView)
  }

  private async finishUpsert(client: PoolClient, row: Draft, split: boolean): Promise<UpsertDraftResult> {
    const view = toDraftView(row)
    await this.publishUpsert(client, view)
    return { draft: view, split }
  }

  private publishUpsert(client: PoolClient, view: DraftView): Promise<unknown> {
    return OutboxRepository.insert(client, "draft:upserted", {
      workspaceId: view.workspaceId,
      targetUserId: view.userId,
      draft: view,
    })
  }

  private publishDelete(
    client: PoolClient,
    workspaceId: string,
    userId: string,
    draftIdValue: string
  ): Promise<unknown> {
    return OutboxRepository.insert(client, "draft:deleted", {
      workspaceId,
      targetUserId: userId,
      draftId: draftIdValue,
    })
  }
}
