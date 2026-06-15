import type { LanguageModel, ModelMessage } from "ai"
import { ulid } from "ulid"
import { logger as baseLogger } from "@threa/agent-runtime/logger"
import {
  base64ToBytes,
  buildMessageAad,
  buildNameAad,
  buildSummaryAad,
  buildWrapAad,
  bytesToBase64,
  decryptAttachmentBytes,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  unwrapStreamKey,
  type AttachmentRef,
} from "@threa/crypto"
import { AgentToolNames } from "@threa/types"
import type {
  EnclaveMidTurnMessage,
  EnclaveSessionAssignment,
  EnclaveSessionResult,
  SealedReply,
  SealedStep,
  SealedStepStart,
  EnclaveSealedSubstep,
  EnclaveSealedName,
  EnclaveSealedSummary,
  EnclaveSskWrap,
} from "@threa/types"
import {
  EnclaveTurnDriver,
  TurnDeliveries,
  declaredUnsupported,
  TurnDigestCollector,
  buildToolPromptSections,
  formatTurnDigestsForPrompt,
  generateTurnDigest,
  parseTurnDigestStepContent,
  foldRollingSummary,
  formatConversationMemoryForPrompt,
  ROLLING_SUMMARY_BATCH_SIZE,
  ROLLING_SUMMARY_MAX_BATCHES,
  type NewMessageAwareness,
  type NewMessageInfo,
  type RollingSummaryMessage,
  type TurnDigestPromptEntry,
  type TurnRequest,
  type TurnSink,
} from "@threa/agent-runtime/runtime"
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
 *
 * Mid-turn messages reach the loop by pulling (UX-12): when `pollNewMessages` is
 * wired, the turn's interjection edge opens each sealed message that landed since
 * its boundary with the SSK it already holds, so a fast follow-up is reconsidered
 * in flight rather than only caught up after completion.
 */

const logger = baseLogger.child({ name: "enclave-interjection" })

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
  onMessage: (reply: SealedReply) => Promise<void>
  /**
   * Open a sealed in-flight step the moment the loop starts it (tool:start, and
   * the leading edge of thinking/message_sent). Lets an open trace dialog render
   * the in-progress step before it finishes, mirroring the non-E2E runtime.
   */
  onStepStarted: (step: SealedStepStart) => Promise<void>
  /**
   * Finalize a sealed trace step in place when it completes (thinking, tool
   * calls, message_sent). Sealed under the same SSK as replies; the backend
   * persists ciphertext only.
   */
  onStep: (step: SealedStep) => Promise<void>
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
   * Persist the sealed rolling conversation summary (C-2), best-effort after the
   * turn when the verbatim window overflowed. The enclave folds the overflow
   * messages into the prior summary, seals the result under the reply SSK, and
   * POSTs it with the advanced cursor; a throw here is swallowed (summarizing
   * never blocks or fails the turn). Omitted → no rolling summary.
   */
  onSealedSummary?: (sealed: EnclaveSealedSummary) => Promise<void>
  /**
   * Cooperative cancellation for long-running tools (research). Wired to the
   * runtime's `toolSignalProvider`, so the user's "Stop research" aborts the web
   * sub-loop gracefully — it returns partial findings and the turn still replies,
   * exactly like the in-process `SessionAbortRegistry` path. Omitted → no cancel.
   */
  abortSignal?: AbortSignal
  /**
   * Mid-turn interjection pull (UX-12): fetch the sealed messages that landed
   * since `afterSequence` so the loop can reconsider a draft when new context
   * arrives mid-turn, instead of only catching up after completion. When wired,
   * the turn's `newMessages` sink becomes a real provider that opens each row
   * with the SSK the enclave already holds; when omitted, the enclave declares
   * interjection unsupported (the pre-poll behavior) and the loop runs straight
   * through.
   */
  pollNewMessages?: (afterSequence: bigint) => Promise<EnclaveMidTurnMessage[]>
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
  const { pollNewMessages, onSealedSummary } = deps

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
  // files are fed eagerly. Keep each item's clear `sequence` and clean markdown
  // alongside its model message so the rolling summary (C-2) can fold the
  // overflow and advance its cursor.
  const opened: OpenedHistoryItem[] = []
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
    opened.push({
      sequence: BigInt(item.sequence),
      role: item.role,
      content: contentMarkdown,
      modelMessage: { role: item.role, content: withAttachmentNote(contentMarkdown, attachmentRefs) },
    })
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

  // Deepened verbatim window (C-2): fill history newest-first under the char
  // budget; the trigger is always kept. Anything older that overflows the budget
  // is folded into the rolling summary at turn end. With no budget the whole
  // shipped window stays verbatim (byte-identical to before this slice).
  const { kept, overflow } = splitVerbatimWindow(opened, promptText.length, request.maxChars)
  const messages: ModelMessage[] = kept.map((item) => item.modelMessage)
  messages.push({ role: "user", content: promptContent } as ModelMessage)

  const replySsk = sskByGeneration.get(request.reply.keyGeneration)
  if (!replySsk) throw new InvokeError("No SSK wrap for the reply's key generation")

  // Prior turns' sealed digests (C-1): open the ones our wraps cover and fold
  // them into the system prompt with the SAME formatter the in-process
  // companion uses, so the two surfaces read identical memory. An unopenable
  // or malformed digest is skipped, never fatal — parity with history items.
  const digestEntries: TurnDigestPromptEntry[] = []
  for (const item of request.recentDigests ?? []) {
    const digestSsk = sskByGeneration.get(item.envelope.keyGeneration)
    if (!digestSsk) continue
    try {
      const raw = await openMessageAsString({
        key: digestSsk,
        envelope: item.envelope,
        ciphertext: base64ToBytes(item.ciphertext),
      })
      const digest = parseTurnDigestStepContent(raw)
      if (digest) digestEntries.push({ completedAt: item.completedAt, digest })
    } catch {
      continue
    }
  }
  const digestBlock = formatTurnDigestsForPrompt(digestEntries)

  // Prior sealed rolling summary (C-2): open the running memory of earlier turns
  // that overflowed the verbatim window and render it as the `## Conversation
  // Memory` block — the SAME formatter the in-process companion uses, so the two
  // surfaces read identical memory. An unopenable (no wrap for its generation) or
  // malformed prior summary degrades to no block, never fatal — parity with
  // history/digests. But unlike an append-only digest, the summary is a single
  // overwritten row gated by a monotonic cursor: if we can't open the prior text
  // we MUST NOT fold a replacement (the fold below is skipped), because the cursor
  // already covers messages 1..K that are no longer in the shipped window —
  // re-sealing from empty would advance the cursor past them and erase that memory
  // for good. Skipping leaves the row intact for a later turn whose wraps can open
  // it (the revive path re-wraps the generation, E2EE-7 / §2.8 Q6).
  const summaryCursor = request.summaryCursor ? BigInt(request.summaryCursor) : null
  let priorSummaryText: string | null = null
  let priorSummaryUnreadable = false
  if (request.priorSummary) {
    const summarySsk = sskByGeneration.get(request.priorSummary.envelope.keyGeneration)
    if (summarySsk) {
      try {
        priorSummaryText = await openMessageAsString({
          key: summarySsk,
          envelope: request.priorSummary.envelope,
          ciphertext: base64ToBytes(request.priorSummary.ciphertext),
        })
      } catch {
        priorSummaryText = null
        priorSummaryUnreadable = true
      }
    } else {
      // A prior summary was shipped but this enclave holds no wrap for its
      // generation — can't extend it without losing the pre-cursor memory.
      priorSummaryUnreadable = true
    }
  }
  const memoryBlock = formatConversationMemoryForPrompt(priorSummaryText)

  const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, cost: 0 }
  const messageIds: string[] = []
  // First reply's plaintext, kept only to seed the auto-title below (never logged
  // or persisted; lives in-process for the turn like all other plaintext here).
  let firstReplyText: string | null = null
  // Last reply's plaintext, kept only to ground the turn digest below (same
  // in-process-only lifetime as firstReplyText).
  let lastReplyText: string | null = null

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

  // Collects the turn's completed tool calls so the digest below can carry the
  // tool work into later turns (C-1) — same collector the companion runs.
  const digestCollector = new TurnDigestCollector()

  const turnTools = buildEnclaveTools({
    ai,
    model,
    modelString: request.model,
    tavilyApiKey: tools?.tavilyApiKey,
    currentTime: tools?.currentTime,
    timezone: tools?.timezone,
    // Per-stream policy travels on the assignment, not in `deps.tools` (which
    // is the enclave's own capability config, e.g. whether it has a Tavily key).
    allowedCategories: request.allowedToolCategories,
    // Conversation-local file access for `load_attachment` (carries empty
    // categories, so the policy filter never drops it; the refs already ride
    // the messages the model reads).
    attachments: { refsById, ciphertextById },
  })

  // The backend ships the prompt WITHOUT tool sections — only the enclave
  // knows which tools it actually wires (its own Tavily key, the per-stream
  // policy above). Advertise exactly the built toolset, then fold in prior
  // turns' digests.
  const toolSections = buildToolPromptSections(turnTools)
  const systemPrompt = [request.system, toolSections, memoryBlock, digestBlock]
    .filter((block): block is string => Boolean(block))
    .join("\n\n")

  // Split the turn into what it IS (the request: model binding, prompt, history,
  // toolset, sampling) and what it touches in the host (the sink: the sealing
  // commit + trace observers, cooperative cancel, and the declared-unsupported
  // interjection edge). The EnclaveTurnDriver maps both onto the same
  // `AgentRuntime` the in-process companion runs — the enclave differs only by
  // delivery and by sealing, never by a forked loop.
  const turnRequest: TurnRequest = {
    delivery: TurnDeliveries.SEALED,
    model,
    modelString: request.model,
    systemPrompt,
    messages,
    tools: turnTools,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    // Lead the trace with the CONTEXT step ("Triggered by: …"): the runtime
    // emits it as a `context:received` event at run start and the observer
    // seals it like any other step. The body is the decrypted prompt;
    // id/author/time are clear metadata. Observer failures are isolated by the
    // runtime's emit (warn + continue), so a trace hiccup never blocks the turn.
    ...(request.trigger
      ? { initialContext: { messages: [{ ...request.trigger, content: promptText, isTrigger: true }] } }
      : {}),
  }

  const turnSink: TurnSink = {
    // Terminal action: mint each reply's id, seal it under the current SSK bound
    // to that id, and stream it back now (awaited, so it's delivered before the
    // loop moves on). The backend stores ciphertext under this id. Citation
    // sources ride INSIDE the sealed payload — they reveal what was researched,
    // so they must never travel as a cleartext column or wire field (E2EE-9). A
    // sourceless reply seals the bare string, byte-identical to before.
    commitMessage: async ({ content, sources }) => {
      if (firstReplyText === null) firstReplyText = content
      lastReplyText = content
      const messageId = `msg_${ulid()}`
      const sealed = await sealMessage({
        key: replySsk,
        keyGeneration: request.reply.keyGeneration,
        payload: serializeSealedPayload(content, undefined, sources),
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
    observers: [traceObserver, digestCollector],
    // Interjection (UX-12 / §2.7): when the host wired the mid-turn pull, give the
    // loop a real provider that opens each sealed message arriving mid-turn with
    // the SSK we already hold — the same reconsider seam the in-process companion
    // uses. Without the pull we declare it unsupported, not silently omit it
    // (§2.2.4): the reason rides the seam for rendering.
    newMessages: pollNewMessages
      ? buildInterjectionAwareness({
          sskByGeneration,
          refsById,
          streamId: request.streamId,
          sessionId: request.sessionId,
          replySenderId: request.reply.senderId,
          pollNewMessages,
        })
      : declaredUnsupported("Ariadne can't see mid-turn messages in encrypted scratchpads"),
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
  }

  // Per turn because the enclave AI is per turn (it accumulates THIS turn's usage).
  const loopResult = await new EnclaveTurnDriver({ ai }).runTurn(turnRequest, turnSink)

  // Turn digest (C-1): condense the turn's tool work with one cheap completion
  // over the same pinned model, seal it as a trailing turn_digest step (the
  // auto-title pattern: post-run, in-enclave, plaintext never leaves), and ship
  // it over the step callback. Best-effort — the replies are already delivered,
  // so a digest failure must never affect the turn. Usage accumulates into the
  // same total recorded at /complete.
  if (digestCollector.hasToolWork) {
    try {
      const digest = await generateTurnDigest({
        ai,
        model,
        modelString: request.model,
        records: digestCollector.records,
        replyText: lastReplyText ?? undefined,
      })
      if (digest) {
        await traceObserver.emitTurnDigest(JSON.stringify(digest))
      }
    } catch {
      // The digest is non-essential; a failure must never affect the reply.
    }
  }

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

  // Rolling conversation summary (C-2): fold the messages that overflowed the
  // verbatim window into the prior summary, seal the result under the reply SSK
  // (the auto-title pattern — post-run, in-enclave, plaintext never leaves), and
  // POST it back with the advanced cursor. Only messages newer than the prior
  // cursor are folded, so nothing is summarized twice. The same shared fold the
  // in-process companion runs, so the two surfaces produce identical memory.
  // Best-effort and last: the replies are already delivered, so a summary
  // failure must never affect the turn. Usage accumulates into the same total.
  const toFold = summaryCursor === null ? overflow : overflow.filter((item) => item.sequence > summaryCursor)
  if (toFold.length > 0 && onSealedSummary && !priorSummaryUnreadable) {
    try {
      let summary = priorSummaryText ?? ""
      let foldedThrough = summaryCursor ?? 0n
      let batches = 0
      for (let i = 0; i < toFold.length && batches < ROLLING_SUMMARY_MAX_BATCHES; i += ROLLING_SUMMARY_BATCH_SIZE) {
        const batch = toFold.slice(i, i + ROLLING_SUMMARY_BATCH_SIZE)
        summary = await foldRollingSummary({
          ai,
          model,
          modelString: request.model,
          existingSummary: summary,
          newMessages: batch.map(toRollingSummaryMessage),
        })
        foldedThrough = batch[batch.length - 1].sequence
        batches++
      }
      if (summary) {
        const sealed = await sealMessage({
          key: replySsk,
          keyGeneration: request.reply.keyGeneration,
          payload: summary,
          aad: buildSummaryAad({ streamId: request.streamId, keyGeneration: request.reply.keyGeneration }),
        })
        await onSealedSummary({
          ciphertext: bytesToBase64(sealed.ciphertext),
          envelope: sealed.envelope,
          lastSummarizedSequence: foldedThrough.toString(),
        })
      }
    } catch {
      // The rolling summary is non-essential; a failure must never affect the reply.
    }
  }

  return {
    messageIds,
    model: request.model,
    usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cost: usage.cost },
    // Report the boundary the loop advanced to via the interjection pull so the
    // backend's post-completion catch-up skips a message this turn already
    // addressed. The awareness seeds at 0 (the backend clamps the floor to the
    // trigger), so a turn that saw nothing past its trigger reports nothing —
    // byte-identical to before the poll existed.
    ...(loopResult.lastProcessedSequence > 0n
      ? { lastProcessedSequence: loopResult.lastProcessedSequence.toString() }
      : {}),
  }
}

/**
 * One opened history message: its clear stream `sequence` and clean markdown
 * (for the rolling-summary fold) carried alongside the `ModelMessage` (with
 * attachment notes) the verbatim window feeds the model.
 */
interface OpenedHistoryItem {
  sequence: bigint
  role: "user" | "assistant"
  content: string
  modelMessage: ModelMessage
}

/**
 * Fill the verbatim window newest-first under `maxChars` (C-2): the trigger's
 * chars are always charged first (it is always kept), then history is kept from
 * newest to oldest while the running total stays within budget. Returns the kept
 * history (oldest→newest, for the model) and the overflow (oldest→newest, to fold
 * into the rolling summary). With no budget the whole window is kept verbatim and
 * nothing overflows — byte-identical to before this slice. At least one history
 * message is kept when any exist, so a degenerate budget can't blank the window.
 */
function splitVerbatimWindow(
  opened: OpenedHistoryItem[],
  promptChars: number,
  maxChars: number | undefined
): { kept: OpenedHistoryItem[]; overflow: OpenedHistoryItem[] } {
  if (maxChars === undefined) return { kept: opened, overflow: [] }
  let used = promptChars
  let keptCount = 0
  for (let i = opened.length - 1; i >= 0; i--) {
    const len = opened[i].content.length
    if (used + len > maxChars && keptCount > 0) break
    used += len
    keptCount++
  }
  const cut = opened.length - keptCount
  return { kept: opened.slice(cut), overflow: opened.slice(0, cut) }
}

function toRollingSummaryMessage(item: OpenedHistoryItem): RollingSummaryMessage {
  return { sequence: item.sequence, authorLabel: item.role, content: item.content }
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

/**
 * The enclave's mid-turn interjection provider (UX-12), mirroring the in-process
 * companion's `NewMessageAwareness` but over sealed input: `check` pulls the
 * messages that landed since the loop's boundary and opens each with the SSK the
 * enclave already holds (skipping any generation it has no wrap for, exactly as
 * history opening does), so no new key machinery is involved. `updateSequence`
 * and `awaitAttachments` are no-ops — the enclave never persists a mid-turn
 * cursor (the loop holds the boundary and reports it at `/complete`), and it
 * injects decrypted markdown with attachment notes rather than awaiting
 * server-side extraction it can't read. The boundary seeds at 0: the backend
 * clamps the floor to the trigger, so pre-trigger history is never replayed.
 */
function buildInterjectionAwareness(params: {
  sskByGeneration: Map<number, Uint8Array>
  refsById: Map<string, AttachmentRef>
  streamId: string
  sessionId: string
  replySenderId: string
  pollNewMessages: (afterSequence: bigint) => Promise<EnclaveMidTurnMessage[]>
}): NewMessageAwareness {
  const { sskByGeneration, refsById, streamId, sessionId, replySenderId, pollNewMessages } = params
  return {
    streamId,
    sessionId,
    // Passed to `check` as `excludeAuthorId`; the backend also drops the persona's
    // own replies, so excluding it here is belt-and-suspenders.
    personaId: replySenderId,
    lastProcessedSequence: 0n,
    check: async (_streamId, sinceSequence) => {
      // A transient pull failure (network blip, 5xx) must not kill an otherwise
      // healthy turn — unlike the in-process companion's `check`, this one crosses
      // an HTTP boundary mid-turn. Treat the boundary as "nothing new" and let the
      // next poll retry the same cursor; any message missed this way is still
      // recovered by the post-completion catch-up, so nothing is permanently
      // dropped. Scrubbed classification only — the enclave never logs payloads.
      let rows: EnclaveMidTurnMessage[]
      try {
        rows = await pollNewMessages(sinceSequence)
      } catch (err) {
        const errorName = err instanceof Error ? err.name : typeof err
        logger.warn({ errorName }, "Interjection poll failed; continuing without mid-turn messages")
        return []
      }
      const infos: NewMessageInfo[] = []
      for (const row of rows) {
        const ssk = sskByGeneration.get(row.envelope.keyGeneration)
        if (!ssk) continue // no wrap for this generation — can't open, skip
        try {
          const raw = await openMessageAsString({
            key: ssk,
            envelope: row.envelope,
            ciphertext: base64ToBytes(row.ciphertext),
          })
          const { contentMarkdown, attachmentRefs } = parseSealedPayload(raw)
          for (const ref of attachmentRefs) refsById.set(ref.attachmentId, ref)
          infos.push({
            sequence: BigInt(row.sequence),
            messageId: row.messageId,
            changeType: "message_created",
            content: withAttachmentNote(contentMarkdown, attachmentRefs),
            authorId: row.authorId,
            authorName: row.authorName,
            authorType: row.authorType,
            createdAt: row.createdAt,
          })
        } catch {
          // An unopenable/malformed row is skipped, never fatal — parity with how
          // history items are opened above.
          continue
        }
      }
      return infos
    },
    updateSequence: async () => {},
    awaitAttachments: async () => {},
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
