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
import type { EnclaveSessionAssignment, EnclaveSessionResult, EnclaveSealedReply, EnclaveSskWrap } from "@threa/types"
import { AgentRuntime } from "@threa/agent-runtime/runtime"
import type { EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import { createEnclaveAI, type UsageAccumulator } from "./enclave-ai"

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
 * The loop runs with no tools and no new-message awareness in this slice — it is
 * the faithful multi-step shell; tools, traces, durability, and mid-turn
 * reconsideration land in later slices.
 */

/** Marks a caller/data fault so the Express layer can answer 400 instead of 500. */
export class InvokeError extends Error {}

export interface EnclaveTurnDeps {
  keyPair: EnclaveKeyPair
  rawChat: RawChatFn
}

export async function runEnclaveTurn(
  deps: EnclaveTurnDeps,
  request: EnclaveSessionAssignment
): Promise<EnclaveSessionResult> {
  const { keyPair, rawChat } = deps

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
  const sealedReplies: EnclaveSealedReply[] = []

  const runtime = new AgentRuntime({
    ai: createEnclaveAI(rawChat, usage),
    // The enclave AI keys off `modelString`; the opaque `model` object is only
    // meaningful to the SDK provider we deliberately don't use.
    model: request.model as unknown as LanguageModel,
    modelString: request.model,
    systemPrompt: request.system,
    messages,
    tools: [],
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    // Terminal action: mint each reply's id, seal it under the current SSK bound
    // to that id, and collect it. The backend stores ciphertext under this id.
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
      sealedReplies.push({ messageId, ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope })
      return { messageId }
    },
  })

  await runtime.run()

  return {
    messages: sealedReplies,
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
