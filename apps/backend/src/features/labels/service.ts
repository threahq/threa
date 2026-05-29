import type { Pool } from "pg"
import { Visibilities, type Label, type LabelMember, type Visibility } from "@threa/types"
import { generateSlug, generateUniqueSlug } from "@threa/backend-common"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { labelId } from "../../lib/id"
import { LabelRepository, LabelMemberRepository, LabelAssignmentRepository } from "./repository"

interface LabelServiceDeps {
  pool: Pool
}

export interface CreateLabelParams {
  workspaceId: string
  userId: string
  name: string
  visibility: Visibility
  color: string
  emoji: string | null
  description: string | null
}

export interface UpdateLabelParams {
  workspaceId: string
  userId: string
  labelId: string
  name?: string
  color?: string
  emoji?: string | null
  description?: string | null
}

/**
 * Label lifecycle: creation, edits (creator-only on public), soft-archive,
 * join/leave, private→public promotion. Routes all writes through the outbox
 * so the real-time fan-out is consistent (INV-4): private events target the
 * creator only, public events go workspace-wide.
 */
export class LabelService {
  private readonly pool: Pool

  constructor(deps: LabelServiceDeps) {
    this.pool = deps.pool
  }

  async listVisibleTo(workspaceId: string, userId: string): Promise<Label[]> {
    return LabelRepository.listVisibleTo(this.pool, workspaceId, userId)
  }

  async listMembershipsForUser(workspaceId: string, userId: string): Promise<LabelMember[]> {
    return LabelMemberRepository.listForUser(this.pool, workspaceId, userId)
  }

  async create(params: CreateLabelParams): Promise<Label> {
    const trimmedName = params.name.trim()
    if (trimmedName.length === 0) {
      throw new HttpError("Label name is required", { status: 400, code: "VALIDATION_ERROR" })
    }

    return withTransaction(this.pool, async (client) => {
      const baseSlug = generateSlug(trimmedName) || "label"
      const slug = await generateUniqueSlug(baseSlug, (candidate) =>
        this.slugExists(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          visibility: params.visibility,
          slug: candidate,
        })
      )

      const id = labelId()
      const label = await LabelRepository.insert(client, {
        id,
        workspaceId: params.workspaceId,
        visibility: params.visibility,
        creatorUserId: params.userId,
        name: trimmedName,
        slug,
        color: params.color,
        emoji: params.emoji,
        description: params.description,
      })

      // Every label — public or private — gets a creator membership row so
      // "joined" is one uniform concept across the model. `creator_user_id`
      // still drives edit/archive/promote permissions; membership drives the
      // "My Labels" view and real-time fan-out.
      const member = await LabelMemberRepository.join(client, {
        labelId: id,
        userId: params.userId,
        workspaceId: params.workspaceId,
      })

      await OutboxRepository.insert(client, "label:created", {
        workspaceId: params.workspaceId,
        targetUserId: params.visibility === Visibilities.PRIVATE ? params.userId : null,
        label,
      })

      // Member events are always delivered to the affected member only, so this
      // is creator-scoped regardless of label visibility.
      await OutboxRepository.insert(client, "label:member_joined", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        member,
      })

      return label
    })
  }

  async update(params: UpdateLabelParams): Promise<Label> {
    return withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.creatorUserId !== params.userId) {
        throw new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" })
      }

      let nextSlug: string | undefined
      if (params.name !== undefined) {
        const trimmedName = params.name.trim()
        if (trimmedName.length === 0) {
          throw new HttpError("Label name is required", { status: 400, code: "VALIDATION_ERROR" })
        }
        const baseSlug = generateSlug(trimmedName) || "label"
        // Recompute only when the slug base changes, and exclude this row so it
        // never collides with its own (possibly suffixed) slug — otherwise a
        // no-op name edit on a suffixed slug would silently bump the suffix.
        if (baseSlug !== existing.slug) {
          nextSlug = await generateUniqueSlug(baseSlug, (candidate) =>
            this.slugExists(client, {
              workspaceId: existing.workspaceId,
              userId: existing.creatorUserId,
              visibility: existing.visibility,
              slug: candidate,
              excludeLabelId: existing.id,
            })
          )
        }
      }

      const updated = await LabelRepository.update(client, params.workspaceId, params.labelId, {
        name: params.name?.trim(),
        slug: nextSlug,
        color: params.color,
        emoji: params.emoji,
        description: params.description,
      })
      if (!updated) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      await OutboxRepository.insert(client, "label:updated", {
        workspaceId: params.workspaceId,
        targetUserId: updated.visibility === Visibilities.PRIVATE ? updated.creatorUserId : null,
        label: updated,
      })

      return updated
    })
  }

  async archive(params: { workspaceId: string; userId: string; labelId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.creatorUserId !== params.userId) {
        throw new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" })
      }

      await this.archiveCascade(client, existing)
    })
  }

  /**
   * Soft-archive a label and tear down everything that hangs off it: member
   * rows, resource assignments, and a `label:deleted` event. Shared by the
   * creator-initiated `archive` and the last-member `leave` path. No per-row
   * unassign events — `label:deleted` already tells clients the label is gone
   * and they skip orphaned assignments on render. No-op if already archived.
   */
  private async archiveCascade(client: import("pg").PoolClient, label: Label): Promise<void> {
    const archived = await LabelRepository.archive(client, label.workspaceId, label.id)
    if (!archived) return

    await LabelMemberRepository.deleteAllForLabel(client, label.id)
    await LabelAssignmentRepository.deleteAllForLabel(client, label.workspaceId, label.id)

    await OutboxRepository.insert(client, "label:deleted", {
      workspaceId: label.workspaceId,
      targetUserId: label.visibility === Visibilities.PRIVATE ? label.creatorUserId : null,
      labelId: label.id,
    })
  }

  async join(params: { workspaceId: string; userId: string; labelId: string }): Promise<LabelMember> {
    return withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.visibility !== Visibilities.PUBLIC) {
        throw new HttpError("Cannot join a private label", { status: 400, code: "LABEL_NOT_PUBLIC" })
      }

      const member = await LabelMemberRepository.join(client, {
        labelId: params.labelId,
        userId: params.userId,
        workspaceId: params.workspaceId,
      })

      await OutboxRepository.insert(client, "label:member_joined", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        member,
      })

      return member
    })
  }

  async leave(params: { workspaceId: string; userId: string; labelId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // Lock the label row so concurrent leaves serialize: the last-member
      // check below must not race two callers into both seeing a survivor
      // (orphaned label) or both archiving (INV-20).
      const existing = await LabelRepository.findByIdForUpdate(client, params.workspaceId, params.labelId)
      if (!existing) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      // No explicit visibility gate: a private label only ever has its creator
      // as a member (join() rejects private labels), so a non-creator's leave
      // no-ops here via `removed === false`.
      const removed = await LabelMemberRepository.leave(client, {
        labelId: params.labelId,
        userId: params.userId,
      })
      if (!removed) return

      // The last member out archives the label so no ownerless label lingers in
      // the workspace (and, for a private label, leaving is its deletion).
      // Clients learn of this via the `label:deleted` emitted by archiveCascade
      // — deliberately not `label:member_left`, since the whole label is gone.
      const remaining = await LabelMemberRepository.countForLabel(client, params.labelId)
      if (remaining === 0) {
        await this.archiveCascade(client, existing)
        return
      }

      await OutboxRepository.insert(client, "label:member_left", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        labelId: params.labelId,
        userId: params.userId,
      })
    })
  }

  /**
   * One-way private → public promotion. The DB still enforces uniqueness via
   * the partial index, so we pre-check here to return a friendly error before
   * the UPDATE fires.
   */
  async promote(params: { workspaceId: string; userId: string; labelId: string }): Promise<Label> {
    return withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.creatorUserId !== params.userId) {
        throw new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" })
      }
      if (existing.visibility !== Visibilities.PRIVATE) {
        throw new HttpError("Label is already public", { status: 409, code: "LABEL_ALREADY_PUBLIC" })
      }

      const collision = await LabelRepository.publicSlugExists(client, params.workspaceId, existing.slug)
      if (collision) {
        throw new HttpError("A public label with this slug already exists", {
          status: 409,
          code: "LABEL_SLUG_TAKEN",
        })
      }

      const promoted = await LabelRepository.promoteToPublic(client, params.workspaceId, params.labelId)
      if (!promoted) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      // The creator already has a membership row (every label gets one at
      // create time), so this join is idempotent — it just re-reads the row to
      // carry in the member_joined event below.
      const member = await LabelMemberRepository.join(client, {
        labelId: promoted.id,
        userId: params.userId,
        workspaceId: params.workspaceId,
      })

      // We emit `label:deleted` to the creator's private channel (so their
      // private view drops the now-stale user-scoped row, membership included)
      // and a workspace-wide `label:created` so everyone picks up the public
      // row. A single `label:updated` could not switch routing because the old
      // row was user-scoped and the new row is workspace-scoped. The
      // `label:member_joined` below then re-adds the creator's membership that
      // `label:deleted` cleared on their client.
      await OutboxRepository.insert(client, "label:deleted", {
        workspaceId: params.workspaceId,
        targetUserId: existing.creatorUserId,
        labelId: promoted.id,
      })
      await OutboxRepository.insert(client, "label:created", {
        workspaceId: params.workspaceId,
        targetUserId: null,
        label: promoted,
      })
      await OutboxRepository.insert(client, "label:member_joined", {
        workspaceId: params.workspaceId,
        targetUserId: params.userId,
        member,
      })

      return promoted
    })
  }

  /** Slug-collision predicate for `generateUniqueSlug`, scoped by visibility. */
  private slugExists(
    client: import("pg").PoolClient,
    params: { workspaceId: string; userId: string; visibility: Visibility; slug: string; excludeLabelId?: string }
  ): Promise<boolean> {
    return params.visibility === Visibilities.PUBLIC
      ? LabelRepository.publicSlugExists(client, params.workspaceId, params.slug, params.excludeLabelId)
      : LabelRepository.privateSlugExists(client, params.workspaceId, params.userId, params.slug, params.excludeLabelId)
  }
}
