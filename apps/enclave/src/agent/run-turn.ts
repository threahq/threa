import type { LanguageModel, ModelMessage } from "ai"
import { ulid } from "ulid"
import {
  base64ToBytes,
  buildMessageAad,
  buildNameAad,
  buildWrapAad,
  bytesToBase64,
  decryptAttachmentBytes,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  unwrapStreamKey,
  type AttachmentRef,
} from "@threa/crypto"
import { AgentToolNames } from "@threa/types"
import type {
  EnclaveSessionAssignment,
  EnclaveSessionResult,
  EnclaveSealedReply,
  EnclaveSealedStep,
  EnclaveSealedStepStart,
  EnclaveSealedSubstep,
  EnclaveSealedName,
  EnclaveSskWrap,
} from "@threa/types"
import { AgentRuntime } from "@threa/agent-runtime/runtime"
import type { EnclaveKeyPair } from "../keystore"
import type { RawChatFn } from "../llm"
import { createEnclaveAI, type UsageAccumulator } from "./enclave-ai"
import { EnclaveTraceObserver } from "./trace-observer"
import { buildEnclaveTools } from "./tools"
import { decodeUtf8 } from "./attachment-tool"
import { generateTitle } from "./auto-title"

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
   * Open a sealed in-flight step the moment the loop starts it (tool:start, and
   * the leading edge of thinking/message_sent). Lets an open trace dialog render
   * the in-progress step before it finishes, mirroring the non-E2E runtime.
   */
  onStepStarted: (step: EnclaveSealedStepStart) => Promise<void>
  /**
   * Finalize a sealed trace step in place when it completes (thinking, tool
   * calls, message_sent). Sealed under the same SSK as replies; the backend
   * persists ciphertext only.
   */
  onStep: (step: EnclaveSealedStep) => Promise<void>
  /** Stream a sealed substep — ephemeral mid-run phase text (e.g. research progress). */
  onSubstep: (substep: EnclaveSealedSubstep) => Promise<void>
  /**
   * Persist a sealed auto-generated title for the scratchpad. Called best-effort
   * after the turn when `request.autoTitle` is set and the turn produced a reply;
   * a throw here is swallowed (titling never blocks or fails the turn). Omitted →
   * no titling.
   */
  onSealedName?: (sealed: EnclaveSealedName) => Promise<void>
  /**
   * Cooperative cancellation for long-running tools (research). Wired to the
   * runtime's `toolSignalProvider`, so the user's "Stop research" aborts the web
   * sub-loop gracefully — it returns partial findings and the turn still replies,
   * exactly like the in-process `SessionAbortRegistry` path. Omitted → no cancel.
   */
  abortSignal?: AbortSignal
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
  const { keyPair, rawChat, onMessage, onStepStarted, onStep, onSubstep, onSealedName, tools, abortSignal } = deps

  // Recover the SSK for every generation the backend wrapped to us. The wrap AAD
  // binds to our own keyId — a wrap addressed elsewhere simply won't open.
  const sskByGeneration = new Map<number, Uint8Array>()
  for (const wrap of request.wraps) {
    sskByGeneration.set(wrap.keyGeneration, await unwrap(keyPair, request.streamId, wrap))
  }

  // Inline attachment ciphertext (trigger + recent history), keyed by id. The
  // backend shipped these because the enclave can't reach S3; the per-file key
  // lives in the decrypted payloads, not here.
  const ciphertextById = new Map((request.attachmentCiphertexts ?? []).map((a) => [a.attachmentId, a.ciphertext]))
  // Every ref the conversation mentions, decrypted out of the sealed payloads —
  // together with `ciphertextById` this powers the `load_attachment` tool.
  const refsById = new Map<string, AttachmentRef>()

  // Open the history this enclave is entitled to. Generations predating our
  // invite have no wrap; that history is skipped rather than fatal. Strip the
  // sealed-payload wrapper so the model sees clean markdown (not the JSON
  // envelope) for any message that carried attachments; an `[Attached: …]`
  // note (with the attachment id) tells the model what's there, and it pulls
  // the actual bytes on demand via `load_attachment` — only the trigger's
  // files are fed eagerly.
  const messages: ModelMessage[] = []
  for (const item of request.history) {
    const ssk = sskByGeneration.get(item.envelope.keyGeneration)
    if (!ssk) continue
    const raw = await openMessageAsString({
      key: ssk,
      envelope: item.envelope,
      ciphertext: base64ToBytes(item.ciphertext),
    })
    const { contentMarkdown, attachmentRefs } = parseSealedPayload(raw)
    for (const ref of attachmentRefs) refsById.set(ref.attachmentId, ref)
    messages.push({ role: item.role, content: withAttachmentNote(contentMarkdown, attachmentRefs) })
  }

  const promptSsk = sskByGeneration.get(request.prompt.envelope.keyGeneration)
  if (!promptSsk) throw new InvokeError("No SSK wrap for the prompt's key generation")
  const promptRaw = await openMessageAsString({
    key: promptSsk,
    envelope: request.prompt.envelope,
    ciphertext: base64ToBytes(request.prompt.ciphertext),
  })
  const { contentMarkdown: promptText, attachmentRefs: promptRefs } = parseSealedPayload(promptRaw)
  for (const ref of promptRefs) refsById.set(ref.attachmentId, ref)
  const promptContent = await buildUserContent(promptText, promptRefs, ciphertextById)
  messages.push({ role: "user", content: promptContent } as ModelMessage)

  const replySsk = sskByGeneration.get(request.reply.keyGeneration)
  if (!replySsk) throw new InvokeError("No SSK wrap for the reply's key generation")

  const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0 }
  const messageIds: string[] = []
  // First reply's plaintext, kept only to seed the auto-title below (never logged
  // or persisted; lives in-process for the turn like all other plaintext here).
  let firstReplyText: string | null = null

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
    sendStepStarted: onStepStarted,
    sendStep: onStep,
    sendSubstep: onSubstep,
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
      // Per-stream policy travels on the assignment, not in `deps.tools` (which
      // is the enclave's own capability config, e.g. whether it has a Tavily key).
      allowedCategories: request.allowedToolCategories,
      // Conversation-local file access for `load_attachment` (ungated; the
      // refs already ride the messages the model reads).
      attachments: { refsById, ciphertextById },
    }),
    observers: [traceObserver],
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    // Hand ONLY the long-running research sub-loop the session's cancel signal so
    // a user "Stop research" aborts it gracefully (partial findings, the turn
    // still replies). Gated by tool name exactly like the in-process path, so a
    // short/uninterruptible tool never receives an already-aborted signal.
    ...(abortSignal
      ? {
          toolSignalProvider: (_toolCallId: string, toolName: string) =>
            toolName === AgentToolNames.GENERAL_RESEARCH ? abortSignal : undefined,
        }
      : {}),
    // Terminal action: mint each reply's id, seal it under the current SSK bound
    // to that id, and stream it back now (awaited, so it's delivered before the
    // loop moves on). The backend stores ciphertext under this id.
    sendMessage: async ({ content }) => {
      if (firstReplyText === null) firstReplyText = content
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

  // Lead with the CONTEXT step ("Triggered by: …") before the loop runs — the
  // enclave's stand-in for the in-process persona-agent orchestration step. The
  // body is the decrypted prompt, sealed by the observer; metadata is clear.
  // Best-effort: a trace failure must never block the actual turn.
  if (request.trigger) {
    await traceObserver.emitContext({ ...request.trigger, content: promptText }).catch(() => {})
  }

  await runtime.run()

  // Auto-title an untitled encrypted scratchpad from the decrypted turn. The
  // server can't do this (it only holds ciphertext), so the enclave generates a
  // short title here, seals it under the reply SSK bound to the name slot
  // (`buildNameAad`), and hands the ciphertext back. Best-effort and last —
  // never block or fail the turn over a title.
  if (request.autoTitle && firstReplyText && onSealedName) {
    try {
      const title = await generateTitle({ rawChat, model: request.model, promptText, replyText: firstReplyText })
      if (title) {
        const sealed = await sealMessage({
          key: replySsk,
          keyGeneration: request.reply.keyGeneration,
          payload: title,
          aad: buildNameAad({ streamId: request.streamId, keyGeneration: request.reply.keyGeneration }),
        })
        await onSealedName({ ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope })
      }
    } catch {
      // Titling is non-essential; a failure must never affect the reply.
    }
  }

  return {
    messageIds,
    model: request.model,
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
  }
}

/**
 * AI-SDK user content parts the enclave builds for an attachment-bearing turn.
 * Structurally match the SDK's `UserContent` part shapes; the whole content is
 * asserted onto `ModelMessage` (the role↔content union needs the cast) and the
 * enclave's `openai-format` maps these to OpenRouter image_url / file parts.
 */
type EnclaveUserPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string }
  | { type: "file"; data: string; mediaType: string; filename: string }

/**
 * Build the trigger user message: clean markdown plus a decrypted multimodal
 * part per attachment, so the (vision/PDF-capable) model reads the actual file —
 * parity with the non-E2E path, which feeds extracted text/images. The per-file
 * key/iv come from the decrypted ref; the ciphertext was shipped inline by the
 * backend. A missing or undecryptable file degrades to a text note rather than
 * failing the turn. No attachments → a plain string (byte-identical to before).
 */
async function buildUserContent(
  contentMarkdown: string,
  refs: AttachmentRef[],
  ciphertextById: Map<string, string>
): Promise<string | EnclaveUserPart[]> {
  if (refs.length === 0) return contentMarkdown
  const media: EnclaveUserPart[] = []
  const notes: string[] = []
  for (const ref of refs) {
    const ct = ciphertextById.get(ref.attachmentId)
    if (!ct) {
      notes.push(`[Attachment "${ref.filename}" is unavailable]`)
      continue
    }
    try {
      const bytes = await decryptAttachmentBytes({ ciphertext: base64ToBytes(ct), key: ref.key, iv: ref.iv })
      if (ref.mimeType.startsWith("image/")) {
        media.push({ type: "image", image: `data:${ref.mimeType};base64,${bytesToBase64(bytes)}` })
      } else if (ref.mimeType === "application/pdf") {
        // The one non-image format models read natively as a `file` part.
        media.push({ type: "file", data: bytesToBase64(bytes), mediaType: ref.mimeType, filename: ref.filename })
      } else {
        // Everything else: if it's valid UTF-8 (markdown, code, CSV, logs —
        // browsers report no MIME for most of these, so the ref often says
        // `application/octet-stream`), inline it as text. A binary blob the
        // model can't read degrades to a note instead of a request the
        // provider would reject.
        const text = decodeUtf8(bytes)
        if (text !== null) {
          notes.push(`Contents of attached file "${ref.filename}":\n\n${text}`)
        } else {
          notes.push(`[Attachment "${ref.filename}" (${ref.mimeType}) is a binary format I can't read directly]`)
        }
      }
    } catch {
      notes.push(`[Attachment "${ref.filename}" could not be decrypted]`)
    }
  }
  // Fold any "unavailable/undecryptable" notes into the leading text so the model
  // still knows a file was meant to be there.
  const text = [contentMarkdown, ...notes].filter((s) => s.length > 0).join("\n\n")
  // No decryptable media → a plain string (byte-identical to the no-attachment path).
  if (media.length === 0) return text
  return [{ type: "text", text }, ...media]
}

/**
 * History attachments aren't auto-fed — the model should know a file is there
 * and pull it on demand: note each filename with the id `load_attachment` takes.
 */
function withAttachmentNote(contentMarkdown: string, refs: AttachmentRef[]): string {
  if (refs.length === 0) return contentMarkdown
  const note = refs.map((r) => `[Attached: "${r.filename}" (${r.attachmentId})]`).join("\n")
  return contentMarkdown.length > 0 ? `${contentMarkdown}\n\n${note}` : note
}

async function unwrap(keyPair: EnclaveKeyPair, streamId: string, wrap: EnclaveSskWrap): Promise<Uint8Array> {
  return unwrapStreamKey({
    enc: base64ToBytes(wrap.wrapEnc),
    ct: base64ToBytes(wrap.wrapCt),
    recipientPrivateKey: keyPair.privateKey,
    aad: buildWrapAad({ streamId, keyGeneration: wrap.keyGeneration, recipientKeyId: keyPair.keyId }),
  })
}
