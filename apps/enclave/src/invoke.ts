import type { Request, Response } from "express"
import { timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  openMessageAsString,
  sealMessage,
  unwrapStreamKey,
} from "@threa/crypto"
import { INTERNAL_API_KEY_HEADER, type EnclaveInvokeRequest, type EnclaveInvokeResponse } from "@threa/types"
import type { EnclaveKeyPair } from "./keystore"
import type { ChatCompletionFn, ChatMessage } from "./llm"

/**
 * `/invoke` — the enclave's only content-bearing endpoint.
 *
 * The backend forwards an E2E scratchpad turn here without ever decrypting it:
 * the ciphertext of the triggering message + prior history, plus the SSK wraps
 * addressed to THIS enclave's EIK. The enclave unwraps each generation's SSK
 * with its in-memory private key, opens the messages, calls the LLM, and seals
 * the reply back under the current SSK. Plaintext exists only in this process,
 * for the duration of the request, and is never logged or persisted.
 */

const streamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.string().min(1),
  aad: z.string().min(1),
})

const sealedMessageSchema = z.object({
  ciphertext: z.string().min(1),
  envelope: streamEnvelopeSchema,
})

export const invokeRequestSchema = z.object({
  streamId: z.string().min(1),
  /** One SSK wrap per generation referenced by `history`/`prompt`, addressed to this EIK. */
  wraps: z
    .array(
      z.object({
        keyGeneration: z.number().int().min(0),
        wrapEnc: z.string().min(1),
        wrapCt: z.string().min(1),
      })
    )
    .min(1)
    .max(64),
  /** Prior turns, oldest→newest. Each item's role tells the model who spoke. */
  history: z
    .array(sealedMessageSchema.extend({ role: z.enum(["user", "assistant"]) }))
    .max(200)
    .default([]),
  /** The user message that triggered this invocation (always the latest `user` turn). */
  prompt: sealedMessageSchema,
  /** Ariadne's system prompt — non-secret persona text the backend supplies in the clear. */
  system: z.string().min(1).max(100_000),
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-4.6`. */
  model: z.string().min(1).max(200),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
  /** Where to seal the reply: current generation + the server-minted reply id + Ariadne's sender id. */
  reply: z.object({
    keyGeneration: z.number().int().min(0),
    messageId: z.string().min(1),
    senderId: z.string().min(1),
  }),
})

// The zod-inferred shape is the runtime guard; the canonical contract lives in
// @threa/types so the backend forwarder builds exactly what we validate here.
export type InvokeRequest = EnclaveInvokeRequest

export interface InvokeDeps {
  keyPair: EnclaveKeyPair
  chatCompletion: ChatCompletionFn
}

/**
 * Pure core of `/invoke` (no Express) so it can be loopback-tested: wrap an SSK
 * to a generated EIK, seal a prompt, run this, and confirm the reply opens.
 */
export async function handleInvoke(deps: InvokeDeps, request: EnclaveInvokeRequest): Promise<EnclaveInvokeResponse> {
  const { keyPair } = deps

  // Recover the SSK for every generation the backend wrapped to us. The wrap AAD
  // binds to our own keyId — a wrap addressed elsewhere simply won't open.
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const wrap of request.wraps) {
    const ssk = await unwrap(keyPair, request.streamId, wrap)
    sskByGeneration.set(wrap.keyGeneration, ssk)
  }

  const messages: ChatMessage[] = [{ role: "system", content: request.system }]

  // History the enclave can't decrypt (generations predating its invite) is
  // skipped rather than fatal — it simply isn't context this actor is entitled to.
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
  if (!promptSsk) {
    throw new InvokeError("No SSK wrap for the prompt's key generation")
  }
  const promptText = await openMessageAsString({
    key: promptSsk,
    envelope: request.prompt.envelope,
    ciphertext: base64ToBytes(request.prompt.ciphertext),
  })
  messages.push({ role: "user", content: promptText })

  const completion = await deps.chatCompletion({
    model: request.model,
    messages,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  })

  const replySsk = sskByGeneration.get(request.reply.keyGeneration)
  if (!replySsk) {
    throw new InvokeError("No SSK wrap for the reply's key generation")
  }
  const sealed = await sealMessage({
    key: replySsk,
    keyGeneration: request.reply.keyGeneration,
    payload: completion.text,
    aad: buildMessageAad({
      streamId: request.streamId,
      messageId: request.reply.messageId,
      senderId: request.reply.senderId,
    }),
  })

  return {
    ciphertext: bytesToBase64(sealed.ciphertext),
    envelope: sealed.envelope,
    model: completion.model,
    usage: completion.usage,
  }
}

async function unwrap(
  keyPair: EnclaveKeyPair,
  streamId: string,
  wrap: { keyGeneration: number; wrapEnc: string; wrapCt: string }
): Promise<Uint8Array> {
  return unwrapStreamKey({
    enc: base64ToBytes(wrap.wrapEnc),
    ct: base64ToBytes(wrap.wrapCt),
    recipientPrivateKey: keyPair.privateKey,
    aad: buildWrapAad({ streamId, keyGeneration: wrap.keyGeneration, recipientKeyId: keyPair.keyId }),
  })
}

/** Marks a caller/data fault so the Express layer can answer 400 instead of 500. */
export class InvokeError extends Error {}

/** Length-safe constant-time secret comparison (avoids the throw on length mismatch). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Express adapter for `/invoke`. Only the backend forwarder may call it — it
 * carries the shared internal-api-key (the EIK pubkey is public, so without this
 * gate anyone could wrap their own SSK to it and use the enclave as an LLM /
 * decryption oracle). Validates the body, runs `handleInvoke`, and answers with
 * status only on failure — error bodies never echo request content (which would
 * defeat the no-plaintext-egress guarantee).
 */
export function createInvokeHandler(deps: InvokeDeps, internalApiKey: string) {
  return async (req: Request, res: Response): Promise<void> => {
    const presented = req.header(INTERNAL_API_KEY_HEADER)
    if (!presented || !secretsMatch(presented, internalApiKey)) {
      res.status(401).json({ error: "Unauthorized" })
      return
    }
    const parsed = invokeRequestSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid invoke request" })
      return
    }
    try {
      // zod has structurally validated the body; the contract type is canonical.
      const result = await handleInvoke(deps, parsed.data as EnclaveInvokeRequest)
      res.json(result)
    } catch (err) {
      if (err instanceof InvokeError) {
        res.status(400).json({ error: err.message })
        return
      }
      // Opaque 500 — a crypto/LLM failure message could carry content.
      res.status(500).json({ error: "Invoke failed" })
    }
  }
}
