import type { Pool } from "pg"
import { Visibilities, type Label, type LabelMember, type Visibility } from "@threa/types"
import { generateSlug, generateUniqueSlug } from "@threa/backend-common"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { labelId } from "../../lib/id"
import { LabelRepository, LabelMemberRepository } from "./repository"

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

      // Creator auto-joins their own public labels so the "My Labels" tab
      // shows them without a separate join hop. Private labels skip this —
      // ownership is derived from `creatorUserId`.
      if (params.visibility === Visibilities.PUBLIC) {
        await LabelMemberRepository.join(client, {
          labelId: id,
          userId: params.userId,
          workspaceId: params.workspaceId,
        })
      }

      await OutboxRepository.insert(client, "label:created", {
        workspaceId: params.workspaceId,
        targetUserId: params.visibility === Visibilities.PRIVATE ? params.userId : null,
        label,
      })

      if (params.visibility === Visibilities.PUBLIC) {
        const member: LabelMember = {
          labelId: id,
          userId: params.userId,
          workspaceId: params.workspaceId,
          joinedAt: label.createdAt,
        }
        await OutboxRepository.insert(client, "label:member_joined", {
          workspaceId: params.workspaceId,
          targetUserId: params.userId,
          member,
        })
      }

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

      const archived = await LabelRepository.archive(client, params.workspaceId, params.labelId)
      if (!archived) return

      await LabelMemberRepository.deleteAllForLabel(client, params.labelId)

      await OutboxRepository.insert(client, "label:deleted", {
        workspaceId: params.workspaceId,
        targetUserId: existing.visibility === Visibilities.PRIVATE ? existing.creatorUserId : null,
        labelId: params.labelId,
      })
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
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }

      const removed = await LabelMemberRepository.leave(client, {
        labelId: params.labelId,
        userId: params.userId,
      })
      if (!removed) return

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

      // A private-only label has no member rows — auto-add the creator so the
      // promoted label still shows in their "My Labels" tab.
      const member = await LabelMemberRepository.join(client, {
        labelId: promoted.id,
        userId: params.userId,
        workspaceId: params.workspaceId,
      })

      // The private creator already had the row; we emit `label:deleted` to
      // the creator's private channel (so their private view drops it) and a
      // workspace-wide `label:created` so everyone else picks it up. A single
      // `label:updated` could not switch routing because the old row was
      // user-scoped and the new row is workspace-scoped.
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
