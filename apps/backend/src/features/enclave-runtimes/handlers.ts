import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { EnclaveRuntime } from "./repository"
import type { EnclaveRuntimesService } from "./service"
import type { EnclaveClaimService } from "./claim-service"

const registerKeySchema = z.object({
  instanceId: z.string().min(1),
  keyId: z.string().min(1),
  publicKey: z.string().min(1),
})

const heartbeatSchema = z.object({
  keyId: z.string().min(1),
})

const revokeSchema = z.object({
  keyId: z.string().min(1),
})

const claimSchema = z.object({
  keyId: z.string().min(1),
})

// EIKs are raw X25519 public keys (32 bytes). Validate at registration so a
// malformed key fails loudly here rather than surfacing later as an opaque
// HPKE-wrap error on the client.
const EIK_PUBLIC_KEY_BYTES = 32

function decodePublicKey(base64: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"))
  if (bytes.length !== EIK_PUBLIC_KEY_BYTES) {
    throw new HttpError("Invalid public key encoding", { status: 400, code: "INVALID_PUBLIC_KEY" })
  }
  return bytes
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
  enclaveClaimService: EnclaveClaimService
}

export function createEnclaveRuntimesHandlers({ enclaveRuntimesService, enclaveClaimService }: Dependencies) {
  return {
    /**
     * POST /internal/enclave-runtimes/register-key
     * Called by an enclave instance on boot (or after key rotation) to
     * register its EIK. Race-safe via ON CONFLICT (key_id). No address is
     * registered — the instance pulls its work over the claim endpoint.
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
     * POST /internal/enclave-runtimes/claims
     * The pull transport's turn start (§2.7): a live enclave instance
     * presents its EIK key id and receives the oldest claimable turn that
     * key can serve — 200 `{ assignment }` — or a bodyless 204 when there is
     * no work (the common poll outcome). Only a registered, non-revoked EIK
     * may claim: the internal-key gate proves the caller is *an* enclave,
     * this check proves it's a live one whose key the claim is keyed to.
     */
    async claim(req: Request, res: Response) {
      const result = claimSchema.safeParse(req.body)
      if (!result.success) {
        throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })
      }
      const isLive = await enclaveRuntimesService.isRegisteredLive(result.data.keyId)
      if (!isLive) {
        throw new HttpError("Enclave runtime not found or revoked", {
          status: 404,
          code: "ENCLAVE_RUNTIME_NOT_FOUND",
        })
      }
      const assignment = await enclaveClaimService.claimTurn(result.data.keyId)
      if (!assignment) {
        res.status(204).end()
        return
      }
      res.status(200).json({ assignment })
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
