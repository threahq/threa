import type { Pool } from "pg"
import { E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { messageId, sessionId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { EnclaveRuntimesService, type EnclaveRuntime } from "../enclave-runtimes"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { MessageRepository, EventService } from "../messaging"
import { UserE2eKeysRepository } from "../user-e2e-keys"
import { AICostService } from "../ai-usage"
import { ARIADNE_AGENT_ID, getBuiltInAgentConfig } from "./built-in-agents"
import { EnclaveClient, type EnclaveHistoryEntry, type EnclaveRecipient } from "./enclave-client"
import type { EnclavePersonaAgentJobData } from "../../lib/queue"

const HISTORY_LIMIT = 50

/**
 * Empty-document placeholder for the persona reply's projection columns. The
 * row is canonically the ciphertext + envelope blob; this lives only so
 * plaintext consumers (search, summary, outbox) don't crash on a null body.
 * Mirrors the structure used by the user-side E2E send path.
 */
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

export interface EnclaveDispatcherDeps {
  pool: Pool
  enclaveClient: EnclaveClient
  enclaveRuntimesService: EnclaveRuntimesService
  messageEventService: EventService
  aiCostService: AICostService
  /** Optional override so unit tests can inject deterministic instance picks. */
  pickInstance?: (runtimes: EnclaveRuntime[]) => EnclaveRuntime
}

function defaultPickInstance(runtimes: EnclaveRuntime[]): EnclaveRuntime {
  if (runtimes.length === 0) throw new Error("defaultPickInstance: no live runtimes")
  return runtimes[Math.floor(Math.random() * runtimes.length)]!
}

/**
 * Dispatches a single E2E persona invocation to a live enclave instance and
 * persists the encrypted reply. Construct once at boot (INV-13); the worker
 * calls `runJob` per queue message.
 *
 * INV-30 / INV-41: this orchestrator only acquires the pool for the discrete
 * load/write steps; the HTTP call to the enclave runs without holding a
 * connection so a slow LLM upstream can't starve the pool.
 */
export class EnclaveDispatcher {
  constructor(private readonly deps: EnclaveDispatcherDeps) {}

  async runJob(job: EnclavePersonaAgentJobData): Promise<void> {
    const { pool, enclaveClient, enclaveRuntimesService, messageEventService, aiCostService } = this.deps
    const pickInstance = this.deps.pickInstance ?? defaultPickInstance

    const persona = getBuiltInAgentConfig(job.personaId)
    if (!persona) {
      throw new Error(`Enclave dispatch: unknown persona ${job.personaId}`)
    }
    if (!persona.e2eCapable) {
      throw new Error(`Enclave dispatch: persona ${job.personaId} is not e2eCapable`)
    }
    const e2eEnabledTools = persona.e2eEnabledTools
    if (!e2eEnabledTools) {
      throw new Error(`Enclave dispatch: persona ${job.personaId} has null e2eEnabledTools`)
    }

    const stream = await StreamRepository.findByIdForWorkspace(pool, job.streamId, job.workspaceId)
    if (!stream) {
      throw new Error(`Enclave dispatch: stream ${job.streamId} not found in workspace ${job.workspaceId}`)
    }

    const e2eRow = await E2eStreamsRepository.getByStreamId(pool, job.workspaceId, job.streamId)
    if (!e2eRow) {
      throw new Error(`Enclave dispatch: e2e_streams row missing for ${job.streamId}`)
    }
    if (e2eRow.invitedAgentKind !== "enclave") {
      logger.warn(
        { streamId: job.streamId, invitedAgentKind: e2eRow.invitedAgentKind },
        "Enclave dispatch invoked on stream where enclave is no longer invited; skipping"
      )
      return
    }

    const ownerUik = await UserE2eKeysRepository.getByKeyId(pool, job.workspaceId, e2eRow.ownerUserKeyId)
    if (!ownerUik) {
      throw new Error(`Enclave dispatch: owner UIK ${e2eRow.ownerUserKeyId} not found`)
    }

    const liveRuntimes = await enclaveRuntimesService.listLive()
    if (liveRuntimes.length === 0) {
      throw new Error("Enclave dispatch: no live enclave runtimes available")
    }

    const recipients: EnclaveRecipient[] = [
      {
        recipientKeyId: ownerUik.keyId,
        publicKey: Buffer.from(ownerUik.publicKey).toString("base64"),
      },
      ...liveRuntimes.map((runtime) => ({
        recipientKeyId: runtime.keyId,
        publicKey: Buffer.from(runtime.publicKey).toString("base64"),
      })),
    ]

    const historyRows = await MessageRepository.list(pool, job.streamId, { limit: HISTORY_LIMIT })
    const history: EnclaveHistoryEntry[] = historyRows
      .filter((m) => m.ciphertext != null && m.envelope != null && m.e2eVersion != null)
      .map((m) => ({
        id: m.id,
        authorId: m.authorId,
        authorType: m.authorType as "user" | "persona" | "bot",
        createdAt: m.createdAt.toISOString(),
        ciphertext: Buffer.from(m.ciphertext!).toString("base64"),
        envelope: m.envelope,
        e2eVersion: m.e2eVersion!,
        sequence: m.sequence.toString(),
      }))

    const replyMessageId = messageId()
    const invocationId = sessionId()
    const sessionIdForRun = sessionId()
    const now = new Date()

    const invokeRequest = {
      invocationId,
      sessionId: sessionIdForRun,
      streamId: job.streamId,
      replyMessageId,
      persona: {
        id: persona.id,
        name: persona.name,
        systemPrompt: persona.systemPrompt,
        model: persona.model,
        temperature: persona.temperature,
        maxTokens: persona.maxTokens,
        e2eEnabledTools: [...e2eEnabledTools],
        currentTime: now.toISOString(),
        timezone: "UTC",
      },
      history,
      recipients,
      aadParts: { streamId: job.streamId, senderId: persona.id },
    }

    // Random pick + one fallback. Selection strategy intentionally simple in
    // 5a — sticky-by-session or least-loaded can come later without a
    // protocol change.
    const primary = pickInstance(liveRuntimes)
    let response
    try {
      response = await enclaveClient.invoke(primary.instanceUrl, invokeRequest)
    } catch (err) {
      const remaining = liveRuntimes.filter((r) => r.id !== primary.id)
      if (remaining.length === 0) {
        throw err
      }
      const fallback = pickInstance(remaining)
      logger.warn(
        {
          invocationId,
          primaryInstanceId: primary.instanceId,
          fallbackInstanceId: fallback.instanceId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Enclave invoke failed on primary; retrying against fallback instance"
      )
      response = await enclaveClient.invoke(fallback.instanceUrl, invokeRequest)
    }

    await messageEventService.createMessage({
      workspaceId: job.workspaceId,
      streamId: job.streamId,
      authorId: persona.id,
      authorType: "persona",
      contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
      contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      ciphertext: Buffer.from(response.reply.ciphertext, "base64"),
      envelope: response.reply.envelope,
      e2eVersion: response.reply.e2eVersion,
      clientMessageId: replyMessageId,
    })

    await aiCostService.recordUsage({
      workspaceId: job.workspaceId,
      sessionId: sessionIdForRun,
      functionId: "enclave_persona_agent",
      model: response.sidecar.modelName,
      provider: response.sidecar.providerName,
      origin: "system",
      usage: {
        promptTokens: response.sidecar.promptTokens,
        completionTokens: response.sidecar.completionTokens,
        totalTokens: response.sidecar.totalTokens,
        cost: response.sidecar.costUsd,
      },
      metadata: {
        invocationId,
        personaId: persona.id,
        streamId: job.streamId,
        latencyMs: response.sidecar.latencyMs,
      },
    })

    logger.info(
      {
        invocationId,
        streamId: job.streamId,
        personaId: persona.id,
        latencyMs: response.sidecar.latencyMs,
        totalTokens: response.sidecar.totalTokens,
      },
      "Enclave persona invocation completed"
    )
  }
}
