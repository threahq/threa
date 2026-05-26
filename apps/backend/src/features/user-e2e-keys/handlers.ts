import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { UserE2eKeysService } from "./service"

// All binary fields travel as base64 on the wire — the server stores opaque
// bytes (BYTEA) and never inspects them. Keep an explicit ceiling so a
// pathological client can't blow up the row size: 32-byte X25519 pubkey,
// ~80-byte AES-GCM wrapped 32-byte private key, 16-byte salt. 4 KiB of base64
// is ~3 KiB raw — far more than any legitimate field needs and small enough
// that a malicious payload is bounded.
const BASE64_MAX = 4096
const base64String = z
  .string()
  .min(1)
  .max(BASE64_MAX)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64")

const kdfParamsSchema = z.object({
  algorithm: z.literal("argon2id"),
  m: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024),
  t: z.number().int().min(1).max(64),
  p: z.number().int().min(1).max(16),
  version: z.number().int().min(1).max(255),
})

const setUserKeySchema = z.object({
  publicKey: base64String,
  encryptedPrivateBundle: base64String,
  kdfSalt: base64String,
  kdfParams: kdfParamsSchema,
})

interface Dependencies {
  userE2eKeysService: UserE2eKeysService
}

function serializeKey(key: {
  keyId: string
  publicKey: Buffer
  encryptedPrivateBundle: Buffer
  kdfSalt: Buffer
  kdfParams: unknown
  createdAt: Date
}) {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey.toString("base64"),
    encryptedPrivateBundle: key.encryptedPrivateBundle.toString("base64"),
    kdfSalt: key.kdfSalt.toString("base64"),
    kdfParams: key.kdfParams,
    createdAt: key.createdAt.toISOString(),
  }
}

export function createUserE2eKeysHandlers({ userE2eKeysService }: Dependencies) {
  return {
    /**
     * GET /api/workspaces/:workspaceId/users/me/e2e-key
     * Returns the active key for the calling user, or 404 if not set up.
     */
    async get(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const key = await userE2eKeysService.getActive(workspaceId, userId)
      if (!key) {
        throw new HttpError("E2E key not set up", { status: 404, code: "E2E_KEY_NOT_FOUND" })
      }

      res.json({ key: serializeKey(key) })
    },

    /**
     * POST /api/workspaces/:workspaceId/users/me/e2e-key
     * Set or rotate the user's active key. Body holds only ciphertext +
     * public key — the server never sees the passphrase or unwrapped private
     * material.
     */
    async set(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      const parsed = setUserKeySchema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError("Invalid E2E key payload", {
          status: 400,
          code: "VALIDATION_ERROR",
        })
      }

      const result = await userE2eKeysService.setUserKey({
        workspaceId,
        userId,
        publicKey: Buffer.from(parsed.data.publicKey, "base64"),
        encryptedPrivateBundle: Buffer.from(parsed.data.encryptedPrivateBundle, "base64"),
        kdfSalt: Buffer.from(parsed.data.kdfSalt, "base64"),
        kdfParams: parsed.data.kdfParams,
      })

      res.status(result.rotated ? 200 : 201).json({
        key: serializeKey(result.key),
        rotated: result.rotated,
      })
    },

    /**
     * DELETE /api/workspaces/:workspaceId/users/me/e2e-key
     * Revoke the active key. This is destructive — any existing E2E content
     * encrypted to this key becomes permanently unreadable on this account.
     * The frontend gates this behind an explicit confirmation.
     */
    async revoke(req: Request, res: Response) {
      const userId = req.user!.id
      const workspaceId = req.workspaceId!

      await userE2eKeysService.revokeActive(workspaceId, userId)
      res.status(204).end()
    },
  }
}

export { setUserKeySchema }
