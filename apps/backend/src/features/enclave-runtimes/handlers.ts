import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { EnclaveRuntime } from "./repository"
import type { EnclaveRuntimesService } from "./service"

/**
 * Block schemes other than http/https and cloud instance-metadata hostnames,
 * and (if `ENCLAVE_INSTANCE_URL_ALLOWED_PREFIXES` is configured) require a
 * prefix match. The dispatcher fetches this URL with the shared bearer
 * attached, so an unconstrained string here is a credential-leak SSRF.
 */
function isPermittedInstanceUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const host = parsed.hostname.toLowerCase()
  if (host === "169.254.169.254" || host === "metadata.google.internal" || host === "169.254.170.2") {
    return false
  }
  const allowedPrefixes = process.env.ENCLAVE_INSTANCE_URL_ALLOWED_PREFIXES
  if (allowedPrefixes && allowedPrefixes.trim().length > 0) {
    const prefixes = allowedPrefixes
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
    if (!prefixes.some((p) => value.startsWith(p))) return false
  }
  return true
}

const registerKeySchema = z.object({
  instanceId: z.string().min(1),
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
  instanceUrl: z.string().url().refine(isPermittedInstanceUrl, { message: "instanceUrl scheme/host not permitted" }),
})

const heartbeatSchema = z.object({
  keyId: z.string().min(1),
})

const revokeSchema = z.object({
  keyId: z.string().min(1),
})

function decodePublicKey(base64: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(base64, "base64"))
  } catch {
    throw new HttpError("Invalid public key encoding", { status: 400, code: "INVALID_PUBLIC_KEY" })
  }
}

function serializeRuntime(runtime: EnclaveRuntime) {
  return {
    instanceId: runtime.instanceId,
    keyId: runtime.keyId,
    publicKey: Buffer.from(runtime.publicKey).toString("base64"),
  }
}

interface Dependencies {
  enclaveRuntimesService: EnclaveRuntimesService
}

export function createEnclaveRuntimesHandlers({ enclaveRuntimesService }: Dependencies) {
  return {
    /**
     * POST /internal/enclave-runtimes/register-key
     * Called by an enclave instance on boot (or after key rotation) to
     * register its EIK. Race-safe via ON CONFLICT (key_id).
     */
    async registerKey(req: Request, res: Response) {
      const result = registerKeySchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const runtime = await enclaveRuntimesService.registerKey({
        instanceId: result.data.instanceId,
        keyId: result.data.keyId,
        publicKey: decodePublicKey(result.data.publicKey),
        instanceUrl: result.data.instanceUrl,
      })
      res.status(201).json({ id: runtime.id })
    },

    /**
     * POST /internal/enclave-runtimes/heartbeat
     * Bumps `last_seen_at` so the instance stays in the live set. A 404
     * tells the caller its row was tombstoned and it should re-register.
     */
    async heartbeat(req: Request, res: Response) {
      const result = heartbeatSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const alive = await enclaveRuntimesService.heartbeat(result.data.keyId)
      if (!alive) {
        throw new HttpError("Enclave runtime not found or revoked", {
          status: 404,
          code: "ENCLAVE_RUNTIME_NOT_FOUND",
        })
      }
      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/revoke
     * Graceful shutdown / operator action. Idempotent.
     */
    async revoke(req: Request, res: Response) {
      const result = revokeSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      await enclaveRuntimesService.revoke(result.data.keyId)
      res.status(204).end()
    },

    /**
     * GET /api/workspaces/:workspaceId/enclave/active-keys
     * Workspace-member auth gates access; the data itself is global. The
     * frontend reads the live EIK set to wrap the SSK to each instance.
     */
    async listActiveKeys(_req: Request, res: Response) {
      const runtimes = await enclaveRuntimesService.listLive()
      res.json({ keys: runtimes.map(serializeRuntime) })
    },
  }
}
