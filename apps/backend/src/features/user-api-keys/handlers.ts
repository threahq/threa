import { z } from "zod"
import type { Request, Response } from "express"
import type { UserApiKeyService } from "./service"
import type { UserApiKeyRow } from "./repository"
import { API_KEY_ELIGIBLE_SCOPES, type WorkspacePermissionSlug, type UserApiKey } from "@threa/types"

const createKeySchema = z.object({
  name: z.string().min(1, "name is required").max(100),
  scopes: z.array(z.enum(API_KEY_ELIGIBLE_SCOPES)).min(1, "at least one scope is required"),
  expiresAt: z
    .string()
    .datetime()
    .nullable()
    .optional()
    .refine((val) => val == null || new Date(val) > new Date(), {
      message: "expiresAt must be a future date",
    }),
})

const updateKeySchema = z.object({
  scopes: z.array(z.enum(API_KEY_ELIGIBLE_SCOPES)).min(1, "at least one scope is required"),
})

const revokeKeySchema = z.object({
  keyId: z.string().min(1),
})

function serializeKey(row: UserApiKeyRow): UserApiKey {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: row.scopes as WorkspacePermissionSlug[],
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

      const result = createKeySchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const { row, value } = await userApiKeyService.createKey({
        workspaceId,
        userId,
        name: result.data.name,
        scopes: result.data.scopes as WorkspacePermissionSlug[],
        expiresAt: result.data.expiresAt ? new Date(result.data.expiresAt) : null,
      })

      res.status(201).json({ key: serializeKey(row), value })
    },

    async update(req: Request, res: Response) {
      const workspaceId = req.workspaceId!
      const userId = req.user!.id
      const { keyId } = req.params

      const result = updateKeySchema.safeParse(req.body)
      if (!result.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: z.flattenError(result.error).fieldErrors,
        })
      }

      const row = await userApiKeyService.updateScopes({
        workspaceId,
        userId,
        keyId,
        scopes: result.data.scopes as WorkspacePermissionSlug[],
      })
      res.json({ key: serializeKey(row) })
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
