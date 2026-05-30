import type { LanguageModel, ModelMessage } from "ai"
import { ulid } from "ulid"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  openMessageAsString,
  sealMessage,
  unwrapStreamKey,
} from "@threa/crypto"
import type {
  EnclaveSessionAssignment,
  EnclaveSessionResult,
  EnclaveSealedReply,
  EnclaveSealedStep,
  EnclaveSskWrap,
} from "@threa/types"
import { AgentRuntime } from "@threa/agent-runtime/runtime"
import type { EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import { createEnclaveAI, type UsageAccumulator } from "./enclave-ai"
import { EnclaveTraceObserver } from "./trace-observer"
import { buildEnclaveTools } from "./tools"

/**
 * The agent turn, run entirely inside the enclave next to decrypted plaintext.
 *
 * The backend forwards an E2E scratchpad turn here without ever decrypting it:
 * the ciphertext of the triggering message + prior history, plus the SSK wraps
 * addressed to THIS enclave's EIK. The enclave unwraps each generation's SSK
 * with its in-memory private key, opens the messages, runs the *same*
 * `AgentRuntime` loop the backend uses for non-E2E personas (via an enclave-only
 * `AgentRuntimeAI` over a single OpenRouter connection), and seals every reply
 * the loop sends back under the current SSK. Plaintext exists only in this
 * process, for the duration of the request, and is never logged or persisted.
 *
 * The loop runs with the enclave-safe web tools (`web_search`, `read_url`, and a
 * web-only `general_research` sub-loop) and is fully traced: an
 * `EnclaveTraceObserver` seals every step the loop emits (the LLM's reasoning,
 * each tool call, each reply) under the SSK and streams it back, so the owner
 * sees Ariadne's work in real time without the server ever reading it.
 * Durability and mid-turn reconsideration land in later slices.
 */

/** Marks a caller/data fault so the Express layer can answer 400 instead of 500. */
export class InvokeError extends Error {}

export interface EnclaveTurnDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
  /**
   * Stream a sealed reply back the moment the loop sends it. Awaited inside the
   * loop's terminal action, so the message is durably delivered *before* the loop
   * continues — an interim "I'll look into it" lands ahead of the final answer
   * rather than batched at completion. A throw here aborts the turn.
   */
  onMessage: (reply: EnclaveSealedReply) => Promise<void>
  /**
   * Stream a sealed trace step back as the loop emits it (thinking, tool calls,
   * message_sent). Sealed under the same SSK as replies; the backend persists
   * ciphertext only.
   */
  onStep: (step: EnclaveSealedStep) => Promise<void>
  /**
   * Web-tool configuration. Absent or keyless degrades gracefully: no Tavily key
   * means no `web_search` (URL reads + research still work). Omitting `tools`
   * entirely runs the loop with `read_url` + research only.
   */
  tools?: {
    tavilyApiKey?: string
    currentTime?: string
    timezone?: string
  }
}

export async function runEnclaveTurn(
  deps: EnclaveTurnDeps,
  request: EnclaveSessionAssignment
): Promise<EnclaveSessionResult> {
  const { keyPair, rawChat, onMessage, onStep, tools } = deps

  // Recover the SSK for every generation the backend wrapped to us. The wrap AAD
  // binds to our own keyId — a wrap addressed elsewhere simply won't open.
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const wrap of request.wraps) {
    sskByGeneration.set(wrap.keyGeneration, await unwrap(keyPair, request.streamId, wrap))
  }

  // Open the history this enclave is entitled to. Generations predating our
  // invite have no wrap; that history is skipped rather than fatal.
  const messages: ModelMessage[] = []
  for (const item of request.history) {
    const ssk = sskByGeneration.get(item.envelope.keyGeneration)
    if (!ssk) continue
    const content = await openMessageAsString({
      key: ssk,
      envelope: item.envelope,
      ciphertext: base64ToBytes(item.ciphertext),
    })
    messages.push({ role: item.role, content })
  }

  const promptSsk = sskByGeneration.get(request.prompt.envelope.keyGeneration)
  if (!promptSsk) throw new InvokeError("No SSK wrap for the prompt's key generation")
  const promptText = await openMessageAsString({
    key: promptSsk,
    envelope: request.prompt.envelope,
    ciphertext: base64ToBytes(request.prompt.ciphertext),
  })
  messages.push({ role: "user", content: promptText })

  const replySsk = sskByGeneration.get(request.reply.keyGeneration)
  if (!replySsk) throw new InvokeError("No SSK wrap for the reply's key generation")

  const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0 }
  const messageIds: string[] = []

  // Construct the enclave AI once so the turn loop and any in-process research
  // sub-loop accumulate token usage into the same total. The enclave AI keys off
  // `modelString`; the opaque `model` object is only meaningful to the SDK
  // provider we deliberately don't use.
  const ai = createEnclaveAI(rawChat, usage)
  const model = request.model as unknown as LanguageModel

  // Seal every trace step under the current (reply) generation and stream it
  // back. The backend stores ciphertext under the enclave-minted step id.
  const traceObserver = new EnclaveTraceObserver({
    streamId: request.streamId,
    replySsk,
    replyKeyGeneration: request.reply.keyGeneration,
    senderId: request.reply.senderId,
    sendStep: onStep,
  })

  const runtime = new AgentRuntime({
    ai,
    model,
    modelString: request.model,
    systemPrompt: request.system,
    messages,
    tools: buildEnclaveTools({
      ai,
      model,
      modelString: request.model,
      tavilyApiKey: tools?.tavilyApiKey,
      currentTime: tools?.currentTime,
      timezone: tools?.timezone,
    }),
    observers: [traceObserver],
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    // Terminal action: mint each reply's id, seal it under the current SSK bound
    // to that id, and stream it back now (awaited, so it's delivered before the
    // loop moves on). The backend stores ciphertext under this id.
    sendMessage: async ({ content }) => {
      const messageId = `msg_${ulid()}`
      const sealed = await sealMessage({
        key: replySsk,
        keyGeneration: request.reply.keyGeneration,
        payload: content,
        aad: buildMessageAad({
          streamId: request.streamId,
          messageId,
          senderId: request.reply.senderId,
        }),
      })
      await onMessage({ messageId, ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope })
      messageIds.push(messageId)
      return { messageId }
    },
  })

  await runtime.run()

  return {
    messageIds,
    model: request.model,
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
  }
}

async function unwrap(keyPair: EnclaveKeyPair, streamId: string, wrap: EnclaveSskWrap): Promise<Uint8Array> {
  return unwrapStreamKey({
    enc: base64ToBytes(wrap.wrapEnc),
    ct: base64ToBytes(wrap.wrapCt),
    recipientPrivateKey: keyPair.privateKey,
    aad: buildWrapAad({ streamId, keyGeneration: wrap.keyGeneration, recipientKeyId: keyPair.keyId }),
  })
}
