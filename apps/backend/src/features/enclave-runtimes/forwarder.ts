import { INTERNAL_API_KEY_HEADER, type EnclaveInvokeRequest, type EnclaveInvokeResponse } from "@threa/types"

/**
 * Backend → enclave client for `POST /invoke`. The backend forwards an
 * E2E scratchpad turn (ciphertext + the SSK wrap addressed to the target EIK)
 * to a live enclave instance and gets back the sealed reply. It never sees
 * plaintext — only the opaque envelopes cross this boundary.
 *
 * Authenticated with the shared internal-API-key header (the same secret the
 * enclave uses to call `/internal/enclave-runtimes/*`). The `instanceUrl` is
 * the address the enclave registered, already SSRF-validated at registration.
 */

/** LLM round-trips can be slow; give the enclave generous headroom before aborting. */
const DEFAULT_TIMEOUT_MS = 120_000

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

  async invoke(instanceUrl: string, request: EnclaveInvokeRequest): Promise<EnclaveInvokeResponse> {
    const url = `${instanceUrl.replace(/\/$/, "")}/invoke`
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INTERNAL_API_KEY_HEADER]: this.internalApiKey,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      // Network failure / timeout — never include the request (it carries ciphertext refs).
      throw new EnclaveForwardError(`Enclave request failed: ${err instanceof Error ? err.message : "network error"}`)
    }
    if (!res.ok) {
      throw new EnclaveForwardError(`Enclave returned ${res.status}`, res.status)
    }
    return (await res.json()) as EnclaveInvokeResponse
  }
}
