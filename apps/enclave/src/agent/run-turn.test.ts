import { describe, expect, it } from "vitest"
import {
  ATTACHMENT_AAD,
  ATTACHMENT_KEY_GENERATION,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  generateStreamKey,
  openMessageAsString,
  parseSealedPayload,
  sealMessage,
  serializeSealedPayload,
  utf8Encode,
  wrapStreamKey,
  type AttachmentRef,
} from "@threa/crypto"
import type {
  SealedReply,
  SealedStep,
  SealedStepStart,
  EnclaveSealedSubstep,
  EnclaveSessionAssignment,
} from "@threa/types"
import { createEnclaveKeyPair, type EnclaveKeyPair } from "../keystore"
import type { RawChatFn, RawChatRequest, RawChatResult } from "../llm"
import { InvokeError, runEnclaveTurn } from "./run-turn"

const STREAM_ID = "stream_journal"
const GEN = 0

/** Collects the replies and sealed trace steps/substeps the loop streams back. */
function collector(): {
  onMessage: (r: SealedReply) => Promise<void>
  onStepStarted: (s: SealedStepStart) => Promise<void>
  onStep: (s: SealedStep) => Promise<void>
  onSubstep: (s: EnclaveSealedSubstep) => Promise<void>
  sent: SealedReply[]
  started: SealedStepStart[]
  steps: SealedStep[]
  substeps: EnclaveSealedSubstep[]
} {
  const sent: SealedReply[] = []
  const started: SealedStepStart[] = []
  const steps: SealedStep[] = []
  const substeps: EnclaveSealedSubstep[] = []
  return {
    sent,
    started,
    steps,
    substeps,
    onMessage: async (r) => void sent.push(r),
    onStepStarted: async (s) => void started.push(s),
    onStep: async (s) => void steps.push(s),
    onSubstep: async (s) => void substeps.push(s),
  }
}

async function wrapSskToEnclave(keyPair: EnclaveKeyPair, ssk: Uint8Array, keyGeneration = GEN) {
  const wrap = await wrapStreamKey({
    key: ssk,
    recipientPublicKey: keyPair.publicKey,
    aad: buildWrapAad({ streamId: STREAM_ID, keyGeneration, recipientKeyId: keyPair.keyId }),
  })
  return { keyGeneration, wrapEnc: bytesToBase64(wrap.enc), wrapCt: bytesToBase64(wrap.ct) }
}

async function sealUnder(ssk: Uint8Array, text: string, messageId: string, senderId: string, keyGeneration = GEN) {
  const sealed = await sealMessage({
    key: ssk,
    keyGeneration,
    payload: text,
    aad: buildMessageAad({ streamId: STREAM_ID, messageId, senderId }),
  })
  return { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope }
}

/** Returns queued responses in order (falling back to the last), recording what it saw. */
function stubChat(responses: RawChatResult | RawChatResult[]): { fn: RawChatFn; seen: RawChatRequest[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses]
  const seen: RawChatRequest[] = []
  const fn: RawChatFn = async (req) => {
    seen.push(req)
    return queue.length > 1 ? queue.shift()! : queue[0]!
  }
  return { fn, seen }
}

function textReply(text: string): RawChatResult {
  return {
    message: { content: text },
    model: "stub/model",
    usage: { prompt_tokens: 11, completion_tokens: 7, cost: 0.002 },
  }
}

function sendMessageReply(...contents: string[]): RawChatResult {
  return {
    message: {
      content: null,
      tool_calls: contents.map((content, i) => ({
        id: `call_${i}`,
        type: "function" as const,
        function: { name: "send_message", arguments: JSON.stringify({ content }) },
      })),
    },
    model: "stub/model",
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }
}

function toolCallReply(name: string, args: Record<string, unknown>): RawChatResult {
  return {
    message: {
      content: null,
      tool_calls: [{ id: "call_tool", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
    },
    model: "stub/model",
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }
}

function baseRequest(over: Partial<EnclaveSessionAssignment>): EnclaveSessionAssignment {
  return {
    sessionId: "session_test",
    streamId: STREAM_ID,
    wraps: [],
    history: [],
    prompt: { ciphertext: "", envelope: { v: 2, keyGeneration: GEN, iv: "", aad: "" } },
    system: "You are Ariadne.",
    model: "anthropic/claude-sonnet-4.6",
    reply: { keyGeneration: GEN, senderId: "persona_ariadne" },
    ...over,
  }
}

describe("runEnclaveTurn", () => {
  it("opens the forwarded turn and seals a reply the owner's SSK can recover", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "What's the capital of France?", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Paris."))
    const { onMessage, onStepStarted, onStep, onSubstep, sent, steps } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    // The model saw the system prompt then the decrypted user turn — never ciphertext —
    // and was offered the send_message tool. The shipped prompt leads; the
    // wired tools' prose (read_url + general_research here) is appended in-enclave.
    const systemMessage = chat.seen[0]?.messages[0]
    expect(systemMessage?.role).toBe("system")
    expect(String(systemMessage?.content)).toMatch(/^You are Ariadne\./)
    expect(String(systemMessage?.content)).toContain("## Reading URLs")
    expect(chat.seen[0]?.messages.slice(1)).toEqual([{ role: "user", content: "What's the capital of France?" }])
    expect(chat.seen[0]?.tools?.some((t) => t.function.name === "send_message")).toBe(true)

    // Exactly one reply, streamed via onMessage, sealed under the same SSK and
    // bound to the id the enclave minted (also returned in messageIds).
    expect(sent).toHaveLength(1)
    const reply = sent[0]!
    expect(reply.messageId).toMatch(/^msg_/)
    expect(result.messageIds).toEqual([reply.messageId])
    const replyText = await openMessageAsString({
      key: ssk,
      envelope: reply.envelope,
      ciphertext: Buffer.from(reply.ciphertext, "base64"),
    })
    expect(replyText).toBe("Paris.")
    expect(reply.envelope.keyGeneration).toBe(GEN)
    expect(result.model).toBe("anthropic/claude-sonnet-4.6")
    // Token counts and OpenRouter's billed cost are summed across the turn and
    // returned for the backend to record (#9).
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7, cost: 0.002 })

    // The reply is also traced as a sealed message_sent step the same SSK opens,
    // linked to the reply id (its content is ciphertext on the wire).
    const messageStep = steps.find((s) => s.stepType === "message_sent")
    expect(messageStep).toBeDefined()
    expect(messageStep!.stepId).toMatch(/^step_/)
    expect(messageStep!.messageId).toBe(reply.messageId)
    const stepText = await openMessageAsString({
      key: ssk,
      envelope: messageStep!.envelope,
      ciphertext: Buffer.from(messageStep!.ciphertext, "base64"),
    })
    expect(stepText).toBe("Paris.")
  })

  it("seals an auto-title the owner's SSK can recover when autoTitle is set", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Help me plan a trip to France.", "msg_user", "usr_owner")
    // First chat = the turn's reply; second = the title generation call.
    const chat = stubChat([textReply("Sure, where to?"), textReply('"Trip planning to France."')])
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    let sealedName: { ciphertext: string; envelope: { keyGeneration: number } } | null = null
    await runEnclaveTurn(
      {
        keyPair,
        rawChat: chat.fn,
        onMessage,
        onStepStarted,
        onStep,
        onSubstep,
        onSealedName: async (s) => void (sealedName = s),
      },
      baseRequest({ wraps: [wrap], prompt, autoTitle: true })
    )

    expect(sealedName).not.toBeNull()
    expect(sealedName!.envelope.keyGeneration).toBe(GEN)
    // The sealed title decrypts under the same SSK (quotes/period stripped).
    const title = await openMessageAsString({
      key: ssk,
      envelope: sealedName!.envelope as never,
      ciphertext: Buffer.from(sealedName!.ciphertext, "base64"),
    })
    expect(title).toBe("Trip planning to France")
  })

  it("does not title when autoTitle is unset", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Just a note.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Noted."))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    let titled = false
    await runEnclaveTurn(
      {
        keyPair,
        rawChat: chat.fn,
        onMessage,
        onStepStarted,
        onStep,
        onSubstep,
        onSealedName: async () => void (titled = true),
      },
      baseRequest({ wraps: [wrap], prompt })
    )

    expect(titled).toBe(false)
  })

  it("seals every message when the loop sends more than one", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Give me two notes.", "msg_user", "usr_owner")
    const chat = stubChat(sendMessageReply("First.", "Second."))
    const { onMessage, onStepStarted, onStep, onSubstep, sent } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    expect(sent).toHaveLength(2)
    const opened = await Promise.all(
      sent.map((m) =>
        openMessageAsString({ key: ssk, envelope: m.envelope, ciphertext: Buffer.from(m.ciphertext, "base64") })
      )
    )
    expect(opened).toEqual(["First.", "Second."])
    // Each reply has a distinct minted id (so each AAD binding is unique), and the
    // result reports them in send order.
    expect(new Set(sent.map((m) => m.messageId)).size).toBe(2)
    expect(result.messageIds).toEqual(sent.map((m) => m.messageId))
  })

  it("includes decryptable history with roles and skips generations it has no wrap for", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    const readable = await sealUnder(ssk, "Earlier, you greeted me.", "msg_old", "persona_ariadne")
    const unreadable = await sealUnder(generateStreamKey(), "secret pre-invite turn", "msg_secret", "usr_owner", 99)
    const prompt = await sealUnder(ssk, "Continue.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Sure."))

    const collected = collector()
    await runEnclaveTurn(
      {
        keyPair,
        rawChat: chat.fn,
        onMessage: collected.onMessage,
        onStepStarted: collected.onStepStarted,
        onStep: collected.onStep,
        onSubstep: collected.onSubstep,
      },
      baseRequest({
        wraps: [wrap],
        history: [
          { ...unreadable, role: "user" },
          { ...readable, role: "assistant" },
        ],
        prompt,
      })
    )

    expect(String(chat.seen[0]?.messages[0]?.content)).toMatch(/^You are Ariadne\./)
    expect(chat.seen[0]?.messages.slice(1)).toEqual([
      { role: "assistant", content: "Earlier, you greeted me." },
      { role: "user", content: "Continue." },
    ])
  })

  it("folds opened recent digests into the system prompt and skips generations it has no wrap for", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "And what about neap tides?", "msg_user", "usr_owner")

    const openableDigest = await sealUnder(
      ssk,
      JSON.stringify({
        findings: "Spring tides align sun and moon.",
        toolsCalled: ["web_search"],
        sources: [],
        sourceStreamIds: [],
      }),
      "step_digest_old",
      "persona_ariadne"
    )
    // Sealed under a generation this enclave has no wrap for — must be skipped, not fatal.
    const strandedSsk = generateStreamKey()
    const strandedSealed = await sealMessage({
      key: strandedSsk,
      keyGeneration: 5,
      payload: JSON.stringify({ findings: "Stranded digest.", toolsCalled: [], sources: [], sourceStreamIds: [] }),
      aad: buildMessageAad({ streamId: STREAM_ID, messageId: "step_digest_stranded", senderId: "persona_ariadne" }),
    })

    const chat = stubChat(textReply("Neap tides are the weak ones."))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({
        wraps: [wrap],
        prompt,
        recentDigests: [
          { ...openableDigest, completedAt: "2026-06-10T10:00:00.000Z" },
          {
            ciphertext: bytesToBase64(strandedSealed.ciphertext),
            envelope: strandedSealed.envelope,
            completedAt: "2026-06-11T10:00:00.000Z",
          },
        ],
      })
    )

    // The system message the model saw carries the opened digest (shared
    // formatter output), but never the one we couldn't open.
    const system = String(chat.seen[0]?.messages[0]?.content ?? "")
    expect(system).toContain("You are Ariadne.")
    expect(system).toContain("## Prior Tool Work (Turn Digests)")
    expect(system).toContain("Spring tides align sun and moon.")
    expect(system).toContain("Turn completed 2026-06-10T10:00:00.000Z")
    expect(system).not.toContain("Stranded digest.")
  })

  it("appends only the wired tools' prose when no digests ride the assignment", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Hello.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Hi!"))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    // No Tavily key in deps → web_search is not wired, so its section must not
    // be advertised; read_url + general_research are. No digest block.
    const system = String(chat.seen[0]?.messages[0]?.content)
    expect(system).toMatch(/^You are Ariadne\./)
    expect(system).toContain("## Reading URLs")
    expect(system).toContain("## General Research")
    expect(system).not.toContain("## Web Search")
    expect(system).not.toContain("## Prior Tool Work")
  })

  it("seals a turn digest step after a tool-using turn, recovered by the owner's SSK", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Read that page for me.", "msg_user", "usr_owner")
    // Turn 1: tool call (SSRF guard keeps it hermetic). Turn 2: the reply.
    // Call 3 is the post-run digest completion over the same transport.
    const chat = stubChat([
      toolCallReply("read_url", { url: "http://localhost/secret" }),
      textReply("Couldn't read it."),
      textReply("Tried to read localhost; it was blocked."),
    ])
    const { onMessage, onStepStarted, onStep, onSubstep, started, steps } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep, tools: { tavilyApiKey: "tvly-test" } },
      baseRequest({ wraps: [wrap], prompt })
    )

    // The digest call ran tool-less after the loop and the step landed sealed,
    // opened + finalized under the same enclave-minted id.
    const digestStep = steps.find((s) => s.stepType === "turn_digest")
    expect(digestStep).toBeDefined()
    expect(started.find((s) => s.stepId === digestStep!.stepId)).toBeDefined()
    expect(chat.seen.at(-1)?.tools).toBeUndefined()

    const opened = await openMessageAsString({
      key: ssk,
      envelope: digestStep!.envelope,
      ciphertext: Buffer.from(digestStep!.ciphertext, "base64"),
    })
    const digest = JSON.parse(opened)
    expect(digest.findings).toBe("Tried to read localhost; it was blocked.")
    expect(digest.toolsCalled).toEqual(["read_url"])
    expect(digest.sourceStreamIds).toEqual([])
  })

  it("does not digest a tool-free turn (no extra model call, no digest step)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Just say hi.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Hi!"))
    const { onMessage, onStepStarted, onStep, onSubstep, steps } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    expect(chat.seen).toHaveLength(1)
    expect(steps.find((s) => s.stepType === "turn_digest")).toBeUndefined()
  })

  it("runs a tool call and seals its trace step under the SSK", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Read that page for me.", "msg_user", "usr_owner")
    // Turn 1: the model calls read_url (SSRF guard blocks localhost before any
    // real network egress — keeps the test hermetic). Turn 2: it answers.
    const chat = stubChat([
      toolCallReply("read_url", { url: "http://localhost/secret" }),
      textReply("Couldn't read it."),
    ])
    const { onMessage, onStepStarted, onStep, onSubstep, sent, steps } = collector()

    const result = await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep, tools: { tavilyApiKey: "tvly-test" } },
      baseRequest({ wraps: [wrap], prompt })
    )

    // The model was offered the enclave web tools alongside send_message.
    const offered = chat.seen[0]?.tools?.map((t) => t.function.name) ?? []
    expect(offered).toEqual(expect.arrayContaining(["web_search", "read_url", "general_research", "send_message"]))

    // The completed tool call was sealed as a trace step the owner's SSK opens.
    const toolStep = steps.find((s) => s.stepType === "visit_page")
    expect(toolStep).toBeDefined()
    expect(toolStep!.stepId).toMatch(/^step_/)
    const opened = await openMessageAsString({
      key: ssk,
      envelope: toolStep!.envelope,
      ciphertext: Buffer.from(toolStep!.ciphertext, "base64"),
    })
    // read_url's trace content is a JSON blob carrying the requested url.
    expect(opened).toContain("localhost")

    // The turn still produced its reply, streamed and reported under the same id.
    expect(result.messageIds[0]).toMatch(/^msg_/)
    expect(sent.find((m) => m.messageId === result.messageIds[0])).toBeDefined()
  })

  it("seals the turn's citation sources inside the reply payload (E2EE-9)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "What causes the tides?", "msg_user", "usr_owner")

    // Hermetic Tavily: web_search's fetch returns one titled result, so the
    // tool reports a SourceItem the loop accumulates into the commit payload.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          query: "tides",
          results: [{ title: "Tide Atlas", url: "https://tides.example/atlas", content: "the moon", score: 0.9 }],
          answer: "The moon.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch

    try {
      const chat = stubChat([toolCallReply("web_search", { query: "tides" }), textReply("Tides come from the moon.")])
      const { onMessage, onStepStarted, onStep, onSubstep, sent } = collector()

      await runEnclaveTurn(
        {
          keyPair,
          rawChat: chat.fn,
          onMessage,
          onStepStarted,
          onStep,
          onSubstep,
          tools: { tavilyApiKey: "tvly-test" },
        },
        baseRequest({ wraps: [wrap], prompt })
      )

      // The reply's sealed payload carries the sources INSIDE the ciphertext —
      // the wire (`SealedReply`) stays ciphertext + envelope only, so the
      // backend never learns what was researched.
      expect(sent).toHaveLength(1)
      const raw = await openMessageAsString({
        key: ssk,
        envelope: sent[0]!.envelope,
        ciphertext: Buffer.from(sent[0]!.ciphertext, "base64"),
      })
      const payload = parseSealedPayload(raw)
      expect(payload.contentMarkdown).toBe("Tides come from the moon.")
      expect(payload.sources).toEqual([{ title: "Tide Atlas", url: "https://tides.example/atlas" }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("seals the bare reply string (no wrapper) when the turn gathered no sources", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const prompt = await sealUnder(ssk, "Say hi.", "msg_user", "usr_owner")
    const chat = stubChat(textReply("Hi."))
    const { onMessage, onStepStarted, onStep, onSubstep, sent } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    // Byte-identical to every sourceless E2E reply already written: a plain
    // string, not the JSON wrapper.
    const raw = await openMessageAsString({
      key: ssk,
      envelope: sent[0]!.envelope,
      ciphertext: Buffer.from(sent[0]!.ciphertext, "base64"),
    })
    expect(raw).toBe("Hi.")
  })

  it("decrypts the trigger's attachments and feeds them as multimodal content", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    // Encrypt two files exactly as the browser does: a fresh per-file key, the
    // single-key attachment envelope (gen 0, the domain-separation AAD).
    const encryptFile = async (bytes: Uint8Array, mimeType: string, filename: string, attachmentId: string) => {
      const fileKey = generateStreamKey()
      const sealed = await sealMessage({
        key: fileKey,
        keyGeneration: ATTACHMENT_KEY_GENERATION,
        payload: bytes,
        aad: ATTACHMENT_AAD,
      })
      const ref: AttachmentRef = {
        attachmentId,
        key: bytesToBase64(fileKey),
        iv: sealed.envelope.iv,
        filename,
        mimeType,
        sizeBytes: bytes.length,
      }
      return { ref, ciphertext: bytesToBase64(sealed.ciphertext) }
    }

    const img = await encryptFile(utf8Encode("fake-png-bytes"), "image/png", "shot.png", "attach_img")
    const pdf = await encryptFile(utf8Encode("fake-pdf-bytes"), "application/pdf", "contract.pdf", "attach_pdf")

    // The prompt seals the versioned wrapper carrying both refs (the per-file keys
    // ride here, inside the SSK ciphertext — never on the wire).
    const prompt = await sealUnder(
      ssk,
      serializeSealedPayload("review these", [img.ref, pdf.ref]),
      "msg_user",
      "usr_owner"
    )
    const chat = stubChat(textReply("On it."))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({
        wraps: [wrap],
        prompt,
        // The backend shipped the opaque ciphertext inline (the enclave can't reach S3).
        attachmentCiphertexts: [
          { attachmentId: "attach_img", ciphertext: img.ciphertext },
          { attachmentId: "attach_pdf", ciphertext: pdf.ciphertext },
        ],
      })
    )

    // The model received the clean markdown (not the JSON wrapper) plus the
    // decrypted image as an image_url data URL and the PDF as a file part —
    // exactly what OpenRouter forwards to a vision/PDF-capable model.
    const userMsg = chat.seen[0]?.messages.find((m) => m.role === "user")
    expect(userMsg?.content).toEqual([
      { type: "text", text: "review these" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${bytesToBase64(utf8Encode("fake-png-bytes"))}` } },
      {
        type: "file",
        file: {
          filename: "contract.pdf",
          file_data: `data:application/pdf;base64,${bytesToBase64(utf8Encode("fake-pdf-bytes"))}`,
        },
      },
    ])
  })

  it("loads a HISTORY attachment on demand via load_attachment (note → tool call → contents)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    // A file shared two turns ago: its ref rides the history message's sealed
    // payload; the backend shipped its ciphertext inline alongside the trigger's.
    const fileKey = generateStreamKey()
    const sealed = await sealMessage({
      key: fileKey,
      keyGeneration: ATTACHMENT_KEY_GENERATION,
      payload: utf8Encode("# Plan\n\nship it"),
      aad: ATTACHMENT_AAD,
    })
    const ref: AttachmentRef = {
      attachmentId: "attach_hist",
      key: bytesToBase64(fileKey),
      iv: sealed.envelope.iv,
      filename: "plan.md",
      mimeType: "application/octet-stream",
      sizeBytes: 16,
    }
    const history = [
      await sealUnder(ssk, serializeSealedPayload("here's the plan", [ref]), "msg_old", "usr_owner"),
    ].map((m) => ({ ...m, role: "user" as const }))
    const prompt = await sealUnder(ssk, "what does the plan file say?", "msg_user", "usr_owner")

    // Turn script: the model asks for the file, then replies.
    const chat = stubChat([
      toolCallReply("load_attachment", { attachmentId: "attach_hist" }),
      textReply("It says: ship it."),
    ])
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({
        wraps: [wrap],
        prompt,
        history,
        attachmentCiphertexts: [{ attachmentId: "attach_hist", ciphertext: bytesToBase64(sealed.ciphertext) }],
      })
    )

    // First call: the history message carries the id-bearing note (not the bytes),
    // and load_attachment is offered even with no web tools configured.
    const first = chat.seen[0]!
    const historyMsg = first.messages.find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("plan")
    )
    expect(historyMsg?.content).toBe('here\'s the plan\n\n[Attached: "plan.md" (attach_hist)]')
    expect(first.tools?.map((t) => t.function.name)).toEqual(expect.arrayContaining(["load_attachment"]))

    // Second call: the tool result carries the decrypted contents (inside the
    // runtime's untrusted-output trust boundary wrapper).
    const second = chat.seen[1]!
    const toolMsg = second.messages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain('Contents of "plan.md":\n\n# Plan\n\nship it')
  })

  it("inlines a UTF-8 text file as contents and degrades a binary blob to a note", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)

    const encryptFile = async (bytes: Uint8Array, mimeType: string, filename: string, attachmentId: string) => {
      const fileKey = generateStreamKey()
      const sealed = await sealMessage({
        key: fileKey,
        keyGeneration: ATTACHMENT_KEY_GENERATION,
        payload: bytes,
        aad: ATTACHMENT_AAD,
      })
      const ref: AttachmentRef = {
        attachmentId,
        key: bytesToBase64(fileKey),
        iv: sealed.envelope.iv,
        filename,
        mimeType,
        sizeBytes: bytes.length,
      }
      return { ref, ciphertext: bytesToBase64(sealed.ciphertext) }
    }

    // Browsers report no MIME for .md, so the ref says octet-stream — the
    // enclave must still recognize valid UTF-8 and inline it as text.
    const md = await encryptFile(
      utf8Encode("# Notes\n\nremember the milk"),
      "application/octet-stream",
      "notes.md",
      "attach_md"
    )
    // 0xFF 0xFE… is not valid UTF-8 → genuinely binary, no model-readable form.
    const bin = await encryptFile(
      new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
      "application/octet-stream",
      "blob.bin",
      "attach_bin"
    )

    const prompt = await sealUnder(
      ssk,
      serializeSealedPayload("read these", [md.ref, bin.ref]),
      "msg_user",
      "usr_owner"
    )
    const chat = stubChat(textReply("done"))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({
        wraps: [wrap],
        prompt,
        attachmentCiphertexts: [
          { attachmentId: "attach_md", ciphertext: md.ciphertext },
          { attachmentId: "attach_bin", ciphertext: bin.ciphertext },
        ],
      })
    )

    // No media parts → the whole turn collapses to one plain string: the user
    // text, the inlined file contents, and the binary note.
    const userMsg = chat.seen[0]?.messages.find((m) => m.role === "user")
    expect(userMsg?.content).toBe(
      'read these\n\nContents of attached file "notes.md":\n\n# Notes\n\nremember the milk\n\n[Attachment "blob.bin" (application/octet-stream) is a binary format I can\'t read directly]'
    )
  })

  it("notes an attachment whose ciphertext the backend couldn't ship, without failing the turn", async () => {
    const keyPair = await createEnclaveKeyPair()
    const ssk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, ssk)
    const ref: AttachmentRef = {
      attachmentId: "attach_missing",
      key: bytesToBase64(generateStreamKey()),
      iv: "aXY=",
      filename: "lost.pdf",
      mimeType: "application/pdf",
      sizeBytes: 10,
    }
    const prompt = await sealUnder(ssk, serializeSealedPayload("see file", [ref]), "msg_user", "usr_owner")
    const chat = stubChat(textReply("ok"))
    const { onMessage, onStepStarted, onStep, onSubstep } = collector()

    // No attachmentCiphertexts shipped → the file degrades to a text note.
    await runEnclaveTurn(
      { keyPair, rawChat: chat.fn, onMessage, onStepStarted, onStep, onSubstep },
      baseRequest({ wraps: [wrap], prompt })
    )

    const userMsg = chat.seen[0]?.messages.find((m) => m.role === "user")
    expect(userMsg?.content).toBe('see file\n\n[Attachment "lost.pdf" is unavailable]')
  })

  it("rejects when the prompt's generation has no wrap (can't read the trigger)", async () => {
    const keyPair = await createEnclaveKeyPair()
    const promptSsk = generateStreamKey()
    const otherSsk = generateStreamKey()
    const wrap = await wrapSskToEnclave(keyPair, otherSsk, 7)
    const prompt = await sealUnder(promptSsk, "hi", "msg_user", "usr_owner", GEN)

    const collected = collector()
    await expect(
      runEnclaveTurn(
        {
          keyPair,
          rawChat: stubChat(textReply("x")).fn,
          onMessage: collected.onMessage,
          onStepStarted: collected.onStepStarted,
          onStep: collected.onStep,
          onSubstep: collected.onSubstep,
        },
        baseRequest({ wraps: [wrap], prompt, reply: { keyGeneration: 7, senderId: "persona_ariadne" } })
      )
    ).rejects.toBeInstanceOf(InvokeError)
  })
})
