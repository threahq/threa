import { describe, it, expect, vi, beforeEach } from "vitest"
import { buildDecisionAad, bytesToBase64, sealMessage } from "@threahq/crypto"
import type { SealedDecisionContent } from "@threahq/types"
import { sealDecisionNote, tryOpenSealedDecision, tryOpenSealedDecisionNote } from "./decision-card"
import * as sessionStore from "@/stores/e2e-session-store"
import * as streamKeyCache from "./stream-key-cache"

const workspaceId = "ws_1"
const streamId = "stream_e2e"
const decisionId = "dreq_1"
const requesterBotId = "bot_1"
const decidedBy = "usr_1"

// A real 32-byte SSK: the seal/open below run actual AES-256-GCM, and only the
// key resolution and session lookup are stubbed.
const ssk = crypto.getRandomValues(new Uint8Array(32))

const unlockedSession = {
  status: "unlocked",
  keyId: "ek_1",
  publicKey: null,
  privateKey: {} as CryptoKey,
  deviceTrusted: true,
  error: null,
} as ReturnType<typeof sessionStore.getE2eSessionState>

const opts = {
  privateKey: unlockedSession.privateKey!,
  recipientKeyId: unlockedSession.keyId!,
  workspaceId,
  streamId,
  rootStreamId: streamId,
}

const content: SealedDecisionContent = {
  title: "Force-push the release branch?",
  bodyMarkdown: "It rewrites two commits already on origin.",
  optionLabels: { yes: "Force-push", no: "Leave it" },
}

/** Seal a card the way the requesting bot does, so the read path opens real bytes. */
async function sealCard(aadParts: { streamId: string; decisionId: string; requesterBotId: string }) {
  const { envelope, ciphertext } = await sealMessage({
    key: ssk,
    keyGeneration: 1,
    payload: JSON.stringify(content),
    aad: buildDecisionAad(aadParts),
  })
  return { ciphertext: bytesToBase64(ciphertext), envelope }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue(unlockedSession)
  vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue({ keyGeneration: 1, key: ssk })
  vi.spyOn(streamKeyCache, "resolveStreamKey").mockResolvedValue(ssk)
})

describe("sealed decision cards", () => {
  it("opens a card sealed under the stream key into the question its requester wrote", async () => {
    const sealed = await sealCard({ streamId, decisionId, requesterBotId })

    const opened = await tryOpenSealedDecision(
      { streamId, decisionId, requesterBotId, ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      opts
    )

    expect(opened).toEqual(content)
  })

  it("refuses a card whose AAD names another slot, even though the key opens it", async () => {
    // Same stream, same key, same bytes — a thread and its root share an SSK, so
    // only the AAD check catches a card relocated onto another decision id.
    const sealed = await sealCard({ streamId, decisionId: "dreq_other", requesterBotId })

    const opened = await tryOpenSealedDecision(
      { streamId, decisionId, requesterBotId, ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      opts
    )

    expect(opened).toBeNull()
  })

  it("refuses a card relabelled as another bot's question", async () => {
    const sealed = await sealCard({ streamId, decisionId, requesterBotId: "bot_other" })

    const opened = await tryOpenSealedDecision(
      { streamId, decisionId, requesterBotId, ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      opts
    )

    expect(opened).toBeNull()
  })

  it("refuses a body that isn't a sealed decision", async () => {
    const { envelope, ciphertext } = await sealMessage({
      key: ssk,
      keyGeneration: 1,
      payload: JSON.stringify({ title: 7 }),
      aad: buildDecisionAad({ streamId, decisionId, requesterBotId }),
    })

    const opened = await tryOpenSealedDecision(
      { streamId, decisionId, requesterBotId, ciphertext: bytesToBase64(ciphertext), envelope },
      opts
    )

    expect(opened).toBeNull()
  })
})

describe("sealed decision notes", () => {
  it("round-trips the note its answerer typed", async () => {
    const sealed = await sealDecisionNote({
      workspaceId,
      keyStreamId: streamId,
      streamId,
      decisionId,
      decidedBy,
      note: "Only if CI is green first.",
    })

    const opened = await tryOpenSealedDecisionNote(
      { streamId, decisionId, decidedBy, ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      opts
    )

    expect(opened).toBe("Only if CI is green first.")
  })

  it("binds the note to who answered — another name on the same bytes won't open", async () => {
    const sealed = await sealDecisionNote({
      workspaceId,
      keyStreamId: streamId,
      streamId,
      decisionId,
      decidedBy,
      note: "Only if CI is green first.",
    })

    const opened = await tryOpenSealedDecisionNote(
      { streamId, decisionId, decidedBy: "usr_other", ciphertext: sealed.ciphertext, envelope: sealed.envelope },
      opts
    )

    expect(opened).toBeNull()
  })

  it("refuses to seal a note on a locked session rather than falling back to plaintext", async () => {
    vi.spyOn(sessionStore, "getE2eSessionState").mockReturnValue({
      ...unlockedSession,
      status: "locked",
      privateKey: null,
      keyId: null,
    } as ReturnType<typeof sessionStore.getE2eSessionState>)

    await expect(
      sealDecisionNote({ workspaceId, keyStreamId: streamId, streamId, decisionId, decidedBy, note: "no" })
    ).rejects.toThrow(/Unlock this scratchpad/)
  })

  it("refuses to seal when the viewer has no key for the stream", async () => {
    vi.spyOn(streamKeyCache, "resolveCurrentStreamKey").mockResolvedValue(null)

    await expect(
      sealDecisionNote({ workspaceId, keyStreamId: streamId, streamId, decisionId, decidedBy, note: "no" })
    ).rejects.toThrow(/access/)
  })
})
