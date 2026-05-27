import type { ModelMessage } from "ai"
import pino from "pino"
import {
  AgentRuntime,
  createAI,
  parseModelId,
  type AI,
  type CostRecorder,
  type UsageWithCost,
} from "@threa/agent-runtime"
import {
  buildMessageAad,
  decryptPayloadAsString,
  encryptPayload,
  ENVELOPE_VERSION,
  type Envelope,
  type EnvelopeRecipientPublic,
} from "@threa/crypto"
import { AuthorTypes, ENCLAVE_HISTORY_LIMIT } from "@threa/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"

const logger = pino({ name: "enclave-orchestrator" })

export interface InvokeHistoryEntry {
  id: string
  authorId: string
  authorType: "user" | "persona" | "bot"
  createdAt: string
  ciphertext: string
  envelope: Envelope
  e2eVersion: number
  sequence: string
}

export interface InvokePersona {
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

export interface InvokeRecipient {
  recipientKeyId: string
  publicKey: string
}

export interface InvokeRequest {
  invocationId: string
  sessionId: string
  streamId: string
  replyMessageId: string
  persona: InvokePersona
  history: InvokeHistoryEntry[]
  recipients: InvokeRecipient[]
  aadParts: { streamId: string; senderId: string }
}

export interface InvokeResponse {
  reply: {
    ciphertext: string
    envelope: Envelope
    e2eVersion: number
  }
  sidecar: {
    modelName: string
    providerName: string
    latencyMs: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    costUsd: number
  }
}

/**
 * Per-invocation cost recorder. The enclave never persists cost itself; it
 * accumulates per-call usage and ships the totals to the backend in the
 * sidecar so `AICostService.recordUsage` can write a single row alongside
 * the encrypted reply (INV-19).
 */
class InMemoryCostRecorder implements CostRecorder {
  totalCost = 0
  promptTokens = 0
  completionTokens = 0
  totalTokens = 0

  async recordUsage(params: { usage: UsageWithCost }): Promise<void> {
    this.totalCost += params.usage.cost ?? 0
    this.promptTokens += params.usage.promptTokens ?? 0
    this.completionTokens += params.usage.completionTokens ?? 0
    this.totalTokens += params.usage.totalTokens ?? 0
  }
}

/**
 * Factory for constructing the AI instance per-invocation. Default builds an
 * OpenRouter-backed AI; tests inject a stub. The factory is per-call so the
 * per-invocation `costRecorder` can sink usage into the right sidecar object.
 */
export type AIFactory = (deps: { costRecorder: CostRecorder }) => AI

export class Orchestrator {
  private readonly aiFactory: AIFactory

  constructor(
    private readonly config: EnclaveConfig,
    private readonly keyPair: EnclaveKeyPair,
    aiFactory?: AIFactory
  ) {
    this.aiFactory =
      aiFactory ??
      ((deps) =>
        createAI({
          openrouter: { apiKey: config.openRouterApiKey },
          costRecorder: deps.costRecorder,
        }))
  }

  async invoke(request: InvokeRequest): Promise<InvokeResponse> {
    if (!this.config.allowedPersonaIds.includes(request.persona.id)) {
      throw new Error(`Persona ${request.persona.id} is not on the enclave allowlist`)
    }

    const messages = await this.decryptHistory(request)
    if (messages.length === 0) {
      throw new Error("Enclave invoke: history decrypted to empty conversation; cannot generate a reply")
    }

    const costRecorder = new InMemoryCostRecorder()
    const ai = this.aiFactory({ costRecorder })
    const model = ai.getLanguageModel(request.persona.model)
    const parsed = parseModelId(request.persona.model)

    const startedAt = Date.now()
    let capturedReply = ""

    // 5a.2: tools=[] hard-wired. We keep send_message wired through the
    // runtime as the terminal action and capture the content into
    // `capturedReply` so we can seal it as the encrypted reply. The
    // outbound message envelope is the only egress side-effect.
    const runtime = new AgentRuntime({
      ai,
      model,
      modelString: request.persona.model,
      costContext: {
        workspaceId: "enclave",
        sessionId: request.sessionId,
        origin: "system",
      },
      systemPrompt: request.persona.systemPrompt,
      messages,
      tools: [],
      maxTokens: request.persona.maxTokens,
      temperature: request.persona.temperature,
      sendMessage: async ({ content }) => {
        capturedReply = content
        return { messageId: request.replyMessageId, operation: "created" }
      },
      telemetry: {
        functionId: "enclave-agent-loop",
        metadata: {
          invocation_id: request.invocationId,
          model_id: parsed.modelId,
          model_provider: parsed.modelProvider,
          model_name: parsed.modelName,
        },
      },
      observers: [],
    })

    const result = await runtime.run()
    const latencyMs = Date.now() - startedAt

    if (!capturedReply) {
      throw new Error("Enclave invoke: agent runtime did not produce a reply via send_message")
    }
    if (result.messagesSent === 0) {
      throw new Error("Enclave invoke: agent runtime reported zero messages sent")
    }

    const recipients: EnvelopeRecipientPublic[] = request.recipients.map((r) => ({
      recipientKeyId: r.recipientKeyId,
      publicKey: Uint8Array.from(Buffer.from(r.publicKey, "base64")),
    }))
    const aad = buildMessageAad({
      streamId: request.aadParts.streamId,
      messageId: request.replyMessageId,
      senderId: request.aadParts.senderId,
    })
    const { envelope } = await encryptPayload({
      payload: capturedReply,
      recipients,
      aad,
    })

    return {
      reply: {
        ciphertext: envelope.ciphertext,
        envelope,
        e2eVersion: ENVELOPE_VERSION,
      },
      sidecar: {
        modelName: parsed.modelName,
        providerName: parsed.modelProvider,
        latencyMs,
        promptTokens: costRecorder.promptTokens,
        completionTokens: costRecorder.completionTokens,
        totalTokens: costRecorder.totalTokens,
        costUsd: costRecorder.totalCost,
      },
    }
  }

  /**
   * Decrypts inbound history entries to plaintext `ModelMessage[]`. Skips
   * entries that fail to decrypt (e.g. envelopes not addressed to any live
   * EIK from a prior invocation cycle) rather than aborting the whole call —
   * the model gets the partial conversation it can read.
   */
  private async decryptHistory(request: InvokeRequest): Promise<ModelMessage[]> {
    const limited = request.history.slice(-ENCLAVE_HISTORY_LIMIT)
    const messages: ModelMessage[] = []
    for (const entry of limited) {
      if (entry.e2eVersion !== ENVELOPE_VERSION) {
        logger.warn(
          { messageId: entry.id, e2eVersion: entry.e2eVersion },
          "Skipping history entry with unsupported envelope version"
        )
        continue
      }
      let plaintext: string
      try {
        plaintext = await decryptPayloadAsString({
          envelope: entry.envelope,
          privateKey: this.keyPair.privateKey,
          recipientKeyId: this.keyPair.keyId,
        })
      } catch (err) {
        logger.warn({ err, messageId: entry.id }, "Skipping history entry that failed to decrypt")
        continue
      }
      const role = entry.authorType === AuthorTypes.USER ? "user" : "assistant"
      messages.push({ role, content: plaintext })
    }
    return messages
  }
}
