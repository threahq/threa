import { z } from "zod"
import type { Request, Response } from "express"
import { personaConfigPatchSchema } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { validateRequest } from "../../lib/validation"
import { getVisibleBuiltInAgentConfig } from "./built-in-agents"
import type { PersonaConfigService } from "./persona-config-service"

interface Dependencies {
  personaConfigService: PersonaConfigService
}

const putOverrideSchema = z.object({
  patch: personaConfigPatchSchema,
  expectedUpdatedAt: z.string().nullable(),
})

const putDraftSchema = z.object({
  patch: personaConfigPatchSchema,
})

function personaNotFound(): HttpError {
  return new HttpError("Persona not found", { status: 404, code: "PERSONA_NOT_FOUND" })
}

/**
 * HTTP surface for persona (built-in agent) config editing (roadmap 7.1/7.2).
 * The list is member-visible; config read and override write are admin-gated at
 * the route layer. An id that is not an editable visible built-in (unknown, or
 * the internal empty shell) is a 404 everywhere.
 */
export function createPersonaConfigHandlers({ personaConfigService }: Dependencies) {
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
      if (result.outcome === "conflict") {
        throw new HttpError("Persona override was modified by someone else", {
          status: 409,
          code: "PERSONA_OVERRIDE_CONFLICT",
          details: { current: result.current },
        })
      }

      res.json({ persona: result.persona, updatedAt: result.updatedAt })
    },

    async putDraft(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      if (!getVisibleBuiltInAgentConfig(personaId)) throw personaNotFound()

      const { patch } = validateRequest(putDraftSchema, req.body)

      const draft = await personaConfigService.saveDraft(workspaceId, personaId, callerId, patch)
      res.json({ draft })
    },

    async deleteDraft(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      if (!getVisibleBuiltInAgentConfig(personaId)) throw personaNotFound()

      await personaConfigService.discardDraft(workspaceId, personaId, callerId)
      res.status(204).end()
    },

    async createTestStream(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId!
      const callerId = req.user!.id

      if (!getVisibleBuiltInAgentConfig(personaId)) throw personaNotFound()

      const result = await personaConfigService.ensureTestStream(workspaceId, personaId, callerId)
      res.json(result)
    },
  }
}
