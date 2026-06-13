import { z } from "zod"
import type { Request, Response } from "express"
import { HttpError } from "../../lib/errors"
import type { EnclaveRuntime } from "./repository"
import type { EnclaveRuntimesService } from "./service"
import type { EnclaveClaimService } from "./claim-service"
import type { EnclaveClaimWaiter } from "./claim-nudge"

/**
 * Server-side ceiling on how long a claim request may be held open (§2.7
 * wake-up nudge). The instance asks for `waitMs`; we clamp to this so a stray
 * large value can't pin a request for minutes, and it stays comfortably under
 * the enclave's own claim-request timeout so the server always answers first.
 */
const ENCLAVE_CLAIM_LONG_POLL_MAX_MS = 30_000

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
  /**
   * Long-poll budget: hold the request open up to this many ms (clamped
   * server-side) waiting for a wake-up nudge before answering 204. Omitted or 0
   * keeps the legacy immediate-204 behavior, so an older caller still works.
   */
  waitMs: z.number().int().nonnegative().optional(),
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
  /**
   * Wake-up nudge the claim long-poll parks on (§2.7). Null when the backend
   * isn't running the LISTEN side, in which case `claim` answers immediately
   * — the nudge is an optimization, not a dependency.
   */
  enclaveClaimNudge: EnclaveClaimWaiter | null
}

export function createEnclaveRuntimesHandlers({
  enclaveRuntimesService,
  enclaveClaimService,
  enclaveClaimNudge,
}: Dependencies) {
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
      const { keyId } = result.data
      const isLive = await enclaveRuntimesService.isRegisteredLive(keyId)
      if (!isLive) {
        throw new HttpError("Enclave runtime not found or revoked", {
          status: 404,
          code: "ENCLAVE_RUNTIME_NOT_FOUND",
        })
      }

      let assignment = await enclaveClaimService.claimTurn(keyId)

      // Long-poll: when there's nothing to hand back yet, hold the request open
      // and re-attempt the claim each time the wake-up nudge fires, until the
      // budget runs out. No DB connection is held across the wait (claimTurn
      // acquires and releases per call; the wait is an in-memory signal), so a
      // parked poll costs only the open socket (INV-41). A nudge that lands in
      // the gap between a claim missing and the next wait subscribing is dropped
      // (classic lost wakeup), but that's bounded: the budget's timeout re-claims
      // and the durable invocation row is the backstop — worst case is one turn
      // waiting out the budget, never a lost message.
      const waitMs = Math.min(result.data.waitMs ?? 0, ENCLAVE_CLAIM_LONG_POLL_MAX_MS)
      if (!assignment && waitMs > 0 && enclaveClaimNudge) {
        const abort = new AbortController()
        const onClose = () => abort.abort()
        req.on("close", onClose)
        try {
          const deadline = Date.now() + waitMs
          while (!assignment && !abort.signal.aborted) {
            const remaining = deadline - Date.now()
            if (remaining <= 0) break
            // `false` means the nudge was stopped (shutdown) — give up rather
            // than re-park on a timer nothing can wake early.
            const live = await enclaveClaimNudge.waitForInvocation({ timeoutMs: remaining, signal: abort.signal })
            if (!live || abort.signal.aborted) break
            assignment = await enclaveClaimService.claimTurn(keyId)
          }
        } finally {
          req.off("close", onClose)
        }
        // The instance hung up mid-wait — don't write to a dead socket (and a
        // claim won in the same tick simply orphans and recycles on its TTL).
        if (abort.signal.aborted) return
      }

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
