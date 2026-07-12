import { z } from "zod"
import type { Request, Response } from "express"
import { personaConfigPatchSchema, personaCustomConfigSchema, PERSONA_NAME_MAX_CHARS } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { getVisibleBuiltInAgentConfig } from "./built-in-agents"
import type { PersonaConfigService } from "./persona-config-service"
import type { AvatarService } from "../workspaces"

interface Dependencies {
  personaConfigService: PersonaConfigService
  avatarService: AvatarService
}

const putOverrideSchema = z.object({
  patch: personaConfigPatchSchema,
  expectedUpdatedAt: z.string().nullable(),
})

const putDraftSchema = z.object({
  patch: personaConfigPatchSchema,
})

const restoreRevisionSchema = z.object({
  expectedUpdatedAt: z.string().nullable(),
})

const forkPersonaSchema = z.object({
  sourcePersonaId: z.string().min(1).nullable(),
  name: z.string().min(1).max(PERSONA_NAME_MAX_CHARS),
})

const putCustomSchema = z.object({
  config: personaCustomConfigSchema,
  expectedUpdatedAt: z.string().nullable(),
})

function personaNotFound(): HttpError {
  return new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })
}

function overrideConflict(current: unknown): HttpError {
  return new HttpError("Persona override was modified by someone else", {
    status: 409,
    code: "PERSONA_OVERRIDE_CONFLICT",
    details: { current },
  })
}

/**
 * HTTP surface for persona (built-in agent) config editing (roadmap 7.1/7.2).
 * The list is member-visible; config read and override write are admin-gated at
 * the route layer. An id that is not an editable visible built-in (unknown, or
 * the internal empty shell) is a 404 everywhere.
 */
export function createPersonaConfigHandlers({ personaConfigService, avatarService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personas = await personaConfigService.listVisible(workspaceId)
      res.json({ personas })
    },

    async getConfig(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const config = await personaConfigService.getConfig(workspaceId, personaId, callerId)
      if (!config) throw personaNotFound()
      res.json(config)
    },

    async putOverride(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      if (!getVisibleBuiltInAgentConfig(personaId)) throw personaNotFound()

      const { patch, expectedUpdatedAt } = validateRequest(putOverrideSchema, req.body)

      const result = await personaConfigService.setOverride(workspaceId, personaId, patch, expectedUpdatedAt, callerId)
      if (result.outcome === "conflict") throw overrideConflict(result.current)

      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    // Fork a source persona into a new custom (admin). Customs are resolved by
    // the service, so no built-in gate here.
    async create(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const callerId = req.user!.id

      const { sourcePersonaId, name } = validateRequest(forkPersonaSchema, req.body)

      const persona = await personaConfigService.forkPersona(workspaceId, sourcePersonaId, name, callerId)
      res.status(201).json({ persona })
    },

    // Full-field update of a CUSTOM persona (admin). A built-in id 400s
    // (PERSONA_NOT_CUSTOM) inside the service; an unknown id 404s.
    async update(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const { config, expectedUpdatedAt } = validateRequest(putCustomSchema, req.body)

      const result = await personaConfigService.updateCustom(
        workspaceId,
        personaId,
        config,
        expectedUpdatedAt,
        callerId
      )
      if (result.outcome === "conflict") throw overrideConflict(result.current)

      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    async archive(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const persona = await personaConfigService.setCustomStatus(workspaceId, personaId, "archived", callerId)
      res.json({ persona })
    },

    async unarchive(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const persona = await personaConfigService.setCustomStatus(workspaceId, personaId, "active", callerId)
      res.json({ persona })
    },

    // The gate for the endpoints below lives in the service (resolveEditable →
    // 404), which covers both built-ins and workspace customs.
    async listArchived(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personas = await personaConfigService.listArchived(workspaceId)
      res.json({ personas })
    },

    async listRevisions(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!

      const revisions = await personaConfigService.listRevisions(workspaceId, personaId)
      res.json({ revisions })
    },

    async restoreRevision(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const revisionId = req.params.revisionId!
      const callerId = req.user!.id

      const { expectedUpdatedAt } = validateRequest(restoreRevisionSchema, req.body)

      const result = await personaConfigService.restoreRevision(
        workspaceId,
        personaId,
        revisionId,
        expectedUpdatedAt,
        callerId
      )
      if (result.outcome === "conflict") throw overrideConflict(result.current)

      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    async putDraft(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const { patch } = validateRequest(putDraftSchema, req.body)

      const draft = await personaConfigService.saveDraft(workspaceId, personaId, callerId, patch)
      res.json({ draft })
    },

    async deleteDraft(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      await personaConfigService.discardDraft(workspaceId, personaId, callerId)
      res.status(204).end()
    },

    async createTestStream(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const result = await personaConfigService.ensureTestStream(workspaceId, personaId, callerId)
      res.json(result)
    },

    /**
     * POST /api/workspaces/:workspaceId/personas/:personaId/avatar
     *
     * Custom personas only (a built-in id 400s PERSONA_NOT_CUSTOM inside the
     * service). Mirrors the bot avatar flow: process the image OUTSIDE the DB txn
     * (INV-41), then commit the pointer + broadcast in one txn, cleaning up old
     * files after commit and orphaned processed files on failure.
     */
    async uploadAvatar(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" })
      }

      const rawS3Key = await avatarService.uploadRawForPersona({
        buffer: req.file.buffer,
        workspaceId,
        personaId,
      })
      const basePath = avatarService.rawKeyToBasePath(rawS3Key)
      const images = await avatarService.processImages(req.file.buffer)
      await avatarService.uploadImages(basePath, images)
      avatarService.deleteRawFile(rawS3Key)

      // On any write failure (not a custom, gone, concurrent change), clean up the
      // just-uploaded processed images so they don't leak.
      let result
      try {
        result = await personaConfigService.setCustomAvatar(workspaceId, personaId, basePath, callerId)
      } catch (error) {
        avatarService.deleteAvatarFiles(basePath)
        throw error
      }

      if (result.previousAvatarUrl) {
        avatarService.deleteAvatarFiles(result.previousAvatarUrl)
      }
      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    /** DELETE /api/workspaces/:workspaceId/personas/:personaId/avatar */
    async removeAvatar(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      const result = await personaConfigService.setCustomAvatar(workspaceId, personaId, null, callerId)
      if (result.previousAvatarUrl) {
        avatarService.deleteAvatarFiles(result.previousAvatarUrl)
      }
      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    /**
     * GET /api/workspaces/:workspaceId/personas/:personaId/avatar/:file
     *
     * Unauthenticated by path (S3 keys carry unguessable ULIDs, matching the bot
     * avatar serve). Immutable cache — a new upload mints a new timestamped key.
     */
    async serveAvatarFile(req: Request, res: Response) {
      const { workspaceId, personaId, file } = req.params
      if (!workspaceId || !personaId || !file) {
        return res.status(404).end()
      }

      try {
        const stream = await avatarService.streamPersonaAvatarFile({ workspaceId, personaId, file })
        if (!stream) return res.status(404).end()

        res.set("Content-Type", "image/webp")
        res.set("Cache-Control", "public, max-age=31536000, immutable")
        stream.on("error", () => {
          if (!res.headersSent) {
            res.status(500).end()
          } else {
            res.end()
          }
        })
        stream.pipe(res)
      } catch {
        return res.status(404).end()
      }
    },
  }
}
