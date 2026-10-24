import { z } from "zod"
import type { Request, Response } from "express"
import { validateRequest } from "../../lib/validation"
import type { UserApiKeyService } from "./service"
import type { UserApiKeyRow } from "./repository"
import { type WorkspacePermissionSlug, type UserApiKey } from "@threahq/types"
import { createApiKeySchema, updateApiKeySchema, type ApiVersion } from "../public-api"

const revokeKeySchema = z.object({
  keyId: z.string().min(1),
})

function serializeKey(row: UserApiKeyRow): UserApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as WorkspacePermissionSlug[],
    apiVersion: row.apiVersion,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

interface Dependencies {
  userApiKeyService: UserApiKeyService
}

export function createUserApiKeyHandlers({ userApiKeyService }: Dependencies) {
  return {
    async list(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const keys = await userApiKeyService.listKeys(workspaceId, userId)
      res.json({ keys: keys.map(serializeKey) })
    },

    async create(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id

      const data = validateRequest(createApiKeySchema, req.body)

      const { row, value } = await userApiKeyService.createKey({
        workspaceId,
        userId,
        name: data.name,
        scopes: data.scopes as WorkspacePermissionSlug[],
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        apiVersion: data.apiVersion,
      })

      res.status(201).json({ key: serializeKey(row), value })
    },

    async update(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { keyId } = req.params

      const data = validateRequest(updateApiKeySchema, req.body)

      let row: UserApiKeyRow | undefined
      if (data.scopes !== undefined) {
        row = await userApiKeyService.updateScopes({
          workspaceId,
          userId,
          keyId,
          scopes: data.scopes as WorkspacePermissionSlug[],
        })
      }
      if (data.apiVersion !== undefined) {
        row = await userApiKeyService.updateApiVersion({
          workspaceId,
          userId,
          keyId,
          apiVersion: data.apiVersion as ApiVersion | null,
        })
      }
      res.json({ key: serializeKey(row!) })
    },

    async revoke(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { keyId } = req.params

      const result = revokeKeySchema.safeParse({ keyId })
      if (!result.success) {
        return res.status(400).json({ error: "Invalid key ID" })
      }

      await userApiKeyService.revokeKey(workspaceId, userId, result.data.keyId)
      res.status(204).send()
    },
  }
}
