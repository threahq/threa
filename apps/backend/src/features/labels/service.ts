import type { Pool, PoolClient } from "pg"
import type { Label, LabelActor } from "@threahq/types"
import { generateSlug, generateUniqueSlug } from "@threahq/backend-common"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { OutboxRepository } from "../../lib/outbox"
import { labelId } from "../../lib/id"
import { LabelRepository, LabelAssignmentRepository } from "./repository"

interface LabelServiceDeps {
  pool: Pool
}

/** Fallback swatch for labels created via the name-based API without a color. */
export const DEFAULT_LABEL_COLOR = "#64748b"

export interface CreateLabelParams {
  workspaceId: string
  actor: LabelActor
  name: string
  color: string
  emoji: string | null
  description: string | null
}

export interface UpsertLabelByNameParams {
  workspaceId: string
  actor: LabelActor
  name: string
  color?: string
  emoji?: string | null
  description?: string | null
}

export interface UpdateLabelParams {
  workspaceId: string
  actor: LabelActor
  labelId: string
  name?: string
  color?: string
  emoji?: string | null
  description?: string | null
}

/**
 * Label lifecycle: creation, edits, soft-archive. Every label is private to its
 * creating actor, so all writes route through the outbox to the owner's user
 * room only (INV-4). The label's text is its external identity — `upsertByName`
 * resolves a name to the actor's single matching label (find-or-create), so
 * callers never juggle ids.
 */
export class LabelService {
  private readonly pool: Pool

  constructor(deps: LabelServiceDeps) {
    this.pool = deps.pool
  }

  async listForActor(workspaceId: string, actorId: string): Promise<Label[]> {
    return LabelRepository.listForActor(this.pool, workspaceId, actorId)
  }

  async create(params: CreateLabelParams): Promise<Label> {
    const trimmedName = params.name.trim()
    if (trimmedName.length === 0) {
      throw new HttpError("Label name is required", { status: 400, code: "VALIDATION_ERROR" })
    }

    return withTransaction(this.pool, async (client) => {
      const baseSlug = generateSlug(trimmedName) || "label"
      const slug = await generateUniqueSlug(baseSlug, (candidate) =>
        LabelRepository.slugExists(client, params.workspaceId, params.actor.id, candidate)
      )

      const label = await LabelRepository.insert(client, {
        id: labelId(),
        workspaceId: params.workspaceId,
        creatorActorType: params.actor.type,
        creatorUserId: params.actor.id,
        name: trimmedName,
        slug,
        color: params.color,
        emoji: params.emoji,
        description: params.description,
      })

      await this.emitUpserted(client, "label:created", label)
      return label
    })
  }

  /**
   * Find-or-create the actor's label for `name` (slug-matched). Appearance
   * fields overwrite the existing row only when explicitly provided, so a bare
   * assign-by-name reuses the label untouched. Emits `label:created` when a new
   * row is born, `label:updated` otherwise — both owner-scoped.
   */
  async upsertByName(params: UpsertLabelByNameParams): Promise<Label> {
    return withTransaction(this.pool, async (client) => {
      const { label } = await this.upsertByNameWithin(client, params)
      return label
    })
  }

  /**
   * The transactional core of {@link upsertByName}, reusable by the assign-by-
   * name flow so the upsert and the assignment commit together. Emits the right
   * label event and returns whether the row was created.
   */
  async upsertByNameWithin(
    client: PoolClient,
    params: UpsertLabelByNameParams
  ): Promise<{ label: Label; inserted: boolean }> {
    const trimmedName = params.name.trim()
    if (trimmedName.length === 0) {
      throw new HttpError("Label name is required", { status: 400, code: "VALIDATION_ERROR" })
    }
    const slug = generateSlug(trimmedName) || "label"

    const { label, inserted } = await LabelRepository.upsertByName(client, {
      id: labelId(),
      workspaceId: params.workspaceId,
      creatorActorType: params.actor.type,
      creatorUserId: params.actor.id,
      name: trimmedName,
      slug,
      color: params.color ?? DEFAULT_LABEL_COLOR,
      emoji: params.emoji ?? null,
      description: params.description ?? null,
      overwriteColor: params.color !== undefined,
      overwriteEmoji: params.emoji !== undefined,
      overwriteDescription: params.description !== undefined,
    })

    await this.emitUpserted(client, inserted ? "label:created" : "label:updated", label)
    return { label, inserted }
  }

  async update(params: UpdateLabelParams): Promise<Label> {
    return withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.creatorUserId !== params.actor.id) {
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
            LabelRepository.slugExists(client, existing.workspaceId, existing.creatorUserId, candidate, existing.id)
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

      await this.emitUpserted(client, "label:updated", updated)
      return updated
    })
  }

  async archive(params: { workspaceId: string; actor: LabelActor; labelId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const existing = await LabelRepository.findById(client, params.workspaceId, params.labelId)
      if (!existing || existing.archivedAt) {
        throw new HttpError("Label not found", { status: 404, code: "LABEL_NOT_FOUND" })
      }
      if (existing.creatorUserId !== params.actor.id) {
        throw new HttpError("Forbidden", { status: 403, code: "FORBIDDEN" })
      }

      const archived = await LabelRepository.archive(client, existing.workspaceId, existing.id)
      if (!archived) return

      // Tear down assignments in the same transaction so no chip outlives its
      // label. No per-row unassign events — `label:deleted` already tells the
      // owner's client the label is gone and it drops orphaned assignments.
      await LabelAssignmentRepository.deleteAllForLabel(client, existing.workspaceId, existing.id)

      await OutboxRepository.insert(client, "label:deleted", {
        workspaceId: existing.workspaceId,
        targetUserId: existing.creatorUserId,
        labelId: existing.id,
      })
    })
  }

  private async emitUpserted(
    client: PoolClient,
    eventType: "label:created" | "label:updated",
    label: Label
  ): Promise<void> {
    await OutboxRepository.insert(client, eventType, {
      workspaceId: label.workspaceId,
      targetUserId: label.creatorUserId,
      label,
    })
  }
}
