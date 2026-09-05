import type { Pool, PoolClient } from "pg"
import type { Draft as DraftView, JSONContent, DraftCommand } from "@threa/types"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { draftId } from "../../lib/id"
import { DraftsRepository, type Draft } from "./repository"
import { toDraftView } from "./view"
import { repairPromotedDraftScopes } from "./promotion"

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
  /**
   * This device's earlier write ids for this draft that were superseded before
   * their ack was observed. Together with `writeId` they form the device's
   * write lineage: a row last written by any of them has no other writer since,
   * so it is updated in place rather than split.
   */
  priorWriteIds: string[]
  clientUpdatedAt: Date
  /** undefined = field absent on the wire (legacy client) → preserve the row's current value. */
  stashedAt: Date | null | undefined
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
  /** On a split against a live row: that untouched row, so the client can seed it. */
  keptDraft?: DraftView
}

export interface ResolveDraftParams {
  workspaceId: string
  userId: string
  id: string
  expectedVersion: number
  supersededWriteIds?: string[]
}

export interface DeleteDraftParams {
  workspaceId: string
  userId: string
  id: string
  /** The discarding device's in-flight write ids, persisted on the tombstone. */
  supersededWriteIds?: string[]
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
   *  b. else lock the existing row. Tombstoned rows: a first push
   *     (`expectedVersion` 0), or any write whose lineage the tombstone
   *     superseded (its `last_client_write_id` / persisted
   *     `superseded_write_ids` intersect the incoming write ids), is a late
   *     push of content the user already sent or discarded — drop it, no
   *     split, no zombie.
   *  c. else CAS-update: `expectedVersion` match, OR the row's last accepted
   *     write is one of the caller's own write ids (a lost ack — no other
   *     device wrote since, so updating in place IS "update the one that is
   *     live"). Match → version+1 and the incoming content applies, no split.
   *  d. else (genuine drift: another device wrote since, or an unrelated
   *     tombstone) → SPLIT: leave the existing row untouched, insert a fresh
   *     `draft_` id carrying the incoming content at version 1. Return
   *     `originalId` so the client migrates its local state to the new id, and
   *     `keptDraft` (when live) so it can seed the other device's copy.
   *
   * Every branch that changes state writes a `draft:upserted` outbox row so the
   * author's other devices converge (INV-4/7, INV-53).
   */
  async upsert(params: UpsertDraftParams): Promise<UpsertDraftResult> {
    return withTransaction(this.pool, async (client) => {
      // This device's write lineage since its last observed ack. If the row's
      // last accepted write is any of these, no other device has written since.
      const ownWriteIds = [params.writeId, ...params.priorWriteIds]
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
        stashedAt: params.stashedAt ?? null,
        lastClientWriteId: params.writeId,
      }

      // (a) Brand-new id.
      const inserted = await DraftsRepository.insertIfAbsent(client, { id: params.id, ...insertParams })
      if (inserted) {
        return this.finishUpsert(client, inserted, false)
      }

      // The id already exists — lock it and decide update vs split.
      const existing = await DraftsRepository.findByIdForUpdate(client, params.workspaceId, params.userId, params.id)

      if (existing?.deletedAt) {
        // (b) Drop the push — no split, no zombie — only when the tombstone can
        // PROVE the content was already sent or discarded:
        //  - an exact `writeId` retry of the tombstone's last accepted write. A
        //    retry reuses its op's writeId, and any typing since replaces the op
        //    with a fresh writeId, so an exact match implies identical content.
        //  - a lineage intersecting the PERSISTED `superseded_write_ids` — the
        //    resolving/discarding device asserted those writes' content was
        //    covered by the send/discard.
        // A priors-only match against `last_client_write_id` proves only that a
        // PREFIX of the caller's lineage landed; the push may carry a newer tail
        // typed after that write (offline edit racing another device's send), so
        // it falls through to the no-loss split — a duplicate is acceptable,
        // destroying the tail is not.
        const exactRetry = existing.lastClientWriteId !== null && existing.lastClientWriteId === params.writeId
        const superseded = new Set(existing.supersededWriteIds ?? [])
        if (exactRetry || ownWriteIds.some((id) => superseded.has(id))) {
          return { draft: toDraftView(existing), split: false }
        }
      } else if (existing) {
        // (c0) Exact lost-ack retry: the row's last accepted write IS this push
        // (same writeId ⇒ identical content, see above) — return it unchanged.
        // True idempotency: no version churn, no redundant outbox echo.
        if (existing.lastClientWriteId === params.writeId) {
          return { draft: toDraftView(existing), split: false }
        }
        // (c) In-place update: version match, or a lost-ack write lineage match
        // (both checked race-safely inside the UPDATE, INV-20). Applying the
        // incoming content on a lineage match matters: a retry can carry NEWER
        // content than the write whose ack was lost (the queue re-reads the
        // draft at drain), and acking without applying would strand that
        // content locally until a cross-device edit overwrote it.
        const updated = await DraftsRepository.casUpdate(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          id: params.id,
          expectedVersion: params.expectedVersion,
          ownWriteIds,
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
          stashedAt: params.stashedAt,
          lastClientWriteId: params.writeId,
        })
        if (updated) {
          return this.finishUpsert(client, updated, false)
        }
      }

      // (d) Genuine drift (or an unrelated tombstone) → split into a fresh draft.
      const newRow = await DraftsRepository.insertIfAbsent(client, { id: draftId(), ...insertParams })
      if (!newRow) {
        // The split id is a freshly minted ULID, so the insert lands unless the
        // id space collided — fail loud (INV-11) rather than feed null forward.
        throw new Error("draft split insert returned no row (id collision)")
      }
      const result = await this.finishUpsert(client, newRow, true)
      // The pushing device ignored the kept row's socket echo while it was
      // dirty; returning the live row lets it seed the copy immediately.
      const keptDraft = existing && !existing.deletedAt ? toDraftView(existing) : undefined
      return { ...result, originalId: params.id, ...(keptDraft ? { keptDraft } : {}) }
    })
  }

  /**
   * Clear a draft on successful send (resolve-on-send). CAS-guarded by
   * `expectedVersion`, with this device's superseded write ids as a lost-ack
   * escape hatch, so unrelated drift survives as a stash entry instead of being
   * collaterally deleted. On a match, soft-delete and emit `draft:deleted`; on
   * drift, leave the row and report `resolved: false`.
   */
  async resolve(params: ResolveDraftParams): Promise<{ resolved: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const supersededWriteIds = params.supersededWriteIds ?? []
      const deleted = await DraftsRepository.softDeleteCas(client, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        id: params.id,
        expectedVersion: params.expectedVersion,
        supersededWriteIds,
      })
      if (!deleted) {
        // Drifted (version moved on — keep the live row) or already tombstoned.
        // In the tombstoned case this resolve's lineage must still be recorded:
        // its device's late-landing push would otherwise carry write ids the
        // tombstone doesn't know and split into a zombie.
        await DraftsRepository.mergeTombstoneSupersededWriteIds(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          id: params.id,
          supersededWriteIds,
        })
        return { resolved: false }
      }
      await this.publishDelete(client, params.workspaceId, params.userId, params.id)
      return { resolved: true }
    })
  }

  /**
   * Explicit discard — the user threw the draft away, so drift doesn't matter.
   * Unconditional soft-delete, idempotent on an already-gone row. Emits
   * `draft:deleted` so other devices drop it too. The device's superseded write
   * ids ride onto the tombstone so its own late-landing push is dropped by the
   * upsert path instead of resurrecting the discarded content.
   */
  async delete(params: DeleteDraftParams): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const supersededWriteIds = params.supersededWriteIds ?? []
      const deleted = await DraftsRepository.softDelete(
        client,
        params.workspaceId,
        params.userId,
        params.id,
        supersededWriteIds
      )
      if (deleted) {
        await this.publishDelete(client, params.workspaceId, params.userId, params.id)
      } else {
        // Already tombstoned by another device — still merge this device's
        // lineage so its own late-landing push is dropped, not zombie-split.
        await DraftsRepository.mergeTombstoneSupersededWriteIds(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          id: params.id,
          supersededWriteIds,
        })
      }
    })
  }

  /**
   * Bootstrap seed for the author's devices (INV-53) — every live draft. Repairs
   * first: a draft still scoped to a client draft id whose scratchpad has since
   * been promoted is re-pointed onto the real stream before it is returned, so
   * a device that lost the promotion's re-scope loads a live draft, not one
   * addressed to a scratchpad that no longer exists.
   */
  async list(params: { workspaceId: string; userId: string }): Promise<DraftView[]> {
    return withTransaction(this.pool, async (client) => {
      await repairPromotedDraftScopes(client, params)
      const rows = await DraftsRepository.listByUser(client, params.workspaceId, params.userId)
      return rows.map(toDraftView)
    })
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
