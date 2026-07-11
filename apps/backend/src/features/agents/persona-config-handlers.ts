import { z } from "zod"
import type { Request, Response } from "express"
import { validateRequest } from "../../lib/validation"
import type { PersonaConfigService } from "./persona-config-service"

// `model: null` clears the workspace override back to the code-backed default.
const updatePersonaConfigSchema = z
  .object({
    model: z.string().trim().min(1).nullable(),
  })
  .strict()

interface Dependencies {
  personaConfigService: PersonaConfigService
}

export function createPersonaConfigHandlers({ personaConfigService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const result = await personaConfigService.listWorkspacePersonas(workspaceId)
      res.json(result)
    },

    // Write is gated to workspace admins at the route layer.
    async updateConfig(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const personaId = req.params.personaId

      const { model } = validateRequest(updatePersonaConfigSchema, req.body)

      const persona = await personaConfigService.updatePersonaModel(workspaceId, personaId, model)
      res.json({ persona })
    },
  }
}
