import { logger } from "../../lib/logger"

/**
 * Request timeout for the enclave invoke call. AI generations can be slow,
 * but anything past a minute is almost always a stuck instance — fail closed
 * so the dispatcher can fall back to a different live enclave.
 */
const INVOKE_TIMEOUT_MS = 60_000

export interface EnclaveRecipient {
  recipientKeyId: string
  publicKey: string
}

export interface EnclaveHistoryEntry {
  id: string
  authorId: string
  authorType: "user" | "persona" | "bot"
  createdAt: string
  ciphertext: string
  envelope: unknown
  e2eVersion: number
  sequence: string
}

export interface EnclavePersonaInput {
  id: string
  name: string
  systemPrompt: string
  model: string
  temperature: number | null
  maxTokens: number | null
  e2eEnabledTools: string[]
  currentTime: string
  timezone: string
}

export interface EnclaveInvokeRequest {
  invocationId: string
  sessionId: string
  streamId: string
  replyMessageId: string
  persona: EnclavePersonaInput
  history: EnclaveHistoryEntry[]
  recipients: EnclaveRecipient[]
  aadParts: { streamId: string; senderId: string }
}

export interface EnclaveInvokeReply {
  ciphertext: string
  envelope: unknown
  e2eVersion: number
}

export interface EnclaveInvokeSidecar {
  modelName: string
  providerName: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
}

export interface EnclaveInvokeResponse {
  reply: EnclaveInvokeReply
  sidecar: EnclaveInvokeSidecar
}

/**
 * HTTP client for the enclave's `/invoke` endpoint. Constructed once at boot
 * with the shared bearer secret (INV-13); per-call code passes the target
 * `instanceUrl` chosen by the dispatcher from the live EIK set.
 *
 * INV-41: callers must release any DB connection before invoking — the
 * enclave call can block for tens of seconds on the LLM upstream.
 */
export class EnclaveClient {
  constructor(private readonly bearerSecret: string) {}

  async invoke(instanceUrl: string, request: EnclaveInvokeRequest): Promise<EnclaveInvokeResponse> {
    const url = `${instanceUrl.replace(/\/$/, "")}/invoke`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.bearerSecret}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      logger.error(
        { instanceUrl, status: res.status, invocationId: request.invocationId, body },
        "Enclave invoke failed"
      )
      throw new Error(`Enclave returned ${res.status}: ${body}`)
    }

    return (await res.json()) as EnclaveInvokeResponse
  }
}
