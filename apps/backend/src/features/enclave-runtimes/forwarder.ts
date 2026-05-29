import { INTERNAL_API_KEY_HEADER, type EnclaveSessionAssignment } from "@threa/types"

/**
 * Backend → enclave client for `POST /sessions`. The backend assigns an
 * E2E scratchpad turn (ciphertext + the SSK wrap addressed to the target EIK +
 * the server-created sessionId) to a live enclave instance. The enclave acks
 * with 202 and runs the agent loop asynchronously, reporting back over the
 * session callbacks (heartbeat / complete). The backend never sees plaintext —
 * only opaque envelopes cross this boundary.
 *
 * Authenticated with the shared internal-API-key header (the same secret the
 * enclave uses to call `/internal/enclave-runtimes/*`). The `instanceUrl` is
 * the address the enclave registered, already SSRF-validated at registration.
 */

/** Assignment is a quick handoff (the enclave returns 202 before doing the work). */
const DEFAULT_TIMEOUT_MS = 15_000

export class EnclaveForwardError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export class EnclaveForwarder {
  private readonly internalApiKey: string
  private readonly timeoutMs: number

  constructor(deps: { internalApiKey: string; timeoutMs?: number }) {
    this.internalApiKey = deps.internalApiKey
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Assign a session to the enclave. Resolves on a 202 ack; throws otherwise. */
  async assignSession(instanceUrl: string, assignment: EnclaveSessionAssignment): Promise<void> {
    const url = `${instanceUrl.replace(/\/$/, "")}/sessions`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(assignment),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      // Network failure / timeout — never include the assignment (it carries ciphertext refs).
      throw new EnclaveForwardError(`Enclave assign failed: ${err instanceof Error ? err.message : "network error"}`)
    }
    // 202 Accepted is the only success: the enclave took ownership and will drive
    // the session over the callbacks. Anything else is a failed handoff.
    if (res.status !== 202) {
      throw new EnclaveForwardError(`Enclave assign returned ${res.status}`, res.status)
    }
  }
}
