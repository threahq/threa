import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { StreamTypes, E2eActorKinds, type Stream } from "@threahq/types"
import { canInviteActor, isActorInvited, revokeActorFromStream } from "./use-e2e-actors"
import { e2eActorsApi } from "@/api/e2e-actors"
import * as streamKeyCache from "@/lib/crypto/stream-key-cache"
import { db } from "@/db"
import type { VirtualStream } from "./use-stream-or-draft"

function makeStream(overrides: Partial<VirtualStream> = {}): VirtualStream {
  return {
    id: "stream_1",
    workspaceId: "ws_1",
    type: StreamTypes.SCRATCHPAD,
    displayName: "Scratch",
    companionMode: "off",
    isDraft: false,
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    archivedAt: null,
    e2eEnabled: true,
    e2eActors: [],
    ...overrides,
  }
}

describe("canInviteActor", () => {
  it("allows an unlocked E2E scratchpad with no invited actor", () => {
    expect(canInviteActor(makeStream(), E2eActorKinds.ENCLAVE)).toBe(true)
  })

  it("rejects when undefined", () => {
    expect(canInviteActor(undefined, E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("rejects non-scratchpad streams", () => {
    expect(canInviteActor(makeStream({ type: StreamTypes.CHANNEL }), E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("rejects drafts", () => {
    expect(canInviteActor(makeStream({ isDraft: true }), E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("rejects plaintext scratchpads", () => {
    expect(canInviteActor(makeStream({ e2eEnabled: false }), E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("rejects when that actor kind is already invited", () => {
    expect(
      canInviteActor(
        makeStream({ e2eActors: [{ kind: E2eActorKinds.ENCLAVE, actorId: "enclave" }] }),
        E2eActorKinds.ENCLAVE
      )
    ).toBe(false)
  })

  it("allows inviting the enclave when only a bot is invited (multi-actor)", () => {
    expect(
      canInviteActor(makeStream({ e2eActors: [{ kind: E2eActorKinds.BOT, actorId: "bot_1" }] }), E2eActorKinds.ENCLAVE)
    ).toBe(true)
  })
})

describe("isActorInvited", () => {
  it("is true only when that kind is present in the actor set", () => {
    const withEnclave = makeStream({ e2eActors: [{ kind: E2eActorKinds.ENCLAVE, actorId: "enclave" }] })
    expect(isActorInvited(withEnclave, E2eActorKinds.ENCLAVE)).toBe(true)
    expect(isActorInvited(withEnclave, E2eActorKinds.BOT)).toBe(false)
    expect(isActorInvited(makeStream({ e2eActors: [] }), E2eActorKinds.ENCLAVE)).toBe(false)
    expect(isActorInvited(undefined, E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("detects an actor among multiple invited kinds", () => {
    const multi = makeStream({
      e2eActors: [
        { kind: E2eActorKinds.BOT, actorId: "bot_1" },
        { kind: E2eActorKinds.ENCLAVE, actorId: "enclave" },
      ],
    })
    expect(isActorInvited(multi, E2eActorKinds.BOT)).toBe(true)
    expect(isActorInvited(multi, E2eActorKinds.ENCLAVE)).toBe(true)
  })
})

describe("revokeActorFromStream", () => {
  const owner = { keyId: "uik_owner", publicKey: new Uint8Array([1, 2, 3]) }
  const remaining = [{ kind: E2eActorKinds.BOT, actorId: "bot_keep", keyId: "rek_keep" }]
  const revokedStream = { id: "stream_1", workspaceId: "ws_1", e2eActors: remaining } as unknown as Stream

  beforeEach(async () => {
    await db.streams.clear()
    await db.streams.add({
      id: "stream_1",
      workspaceId: "ws_1",
      e2eActors: [...remaining, { kind: E2eActorKinds.BOT, actorId: "bot_gone", keyId: "rek_gone" }],
    } as never)
  })

  afterEach(() => vi.restoreAllMocks())

  it("rolls the key to whoever is left and drops the revoked actor from the local row", async () => {
    vi.spyOn(e2eActorsApi, "revoke").mockResolvedValue({
      stream: revokedStream,
      keyRoll: { nextGeneration: 4, recipients: [{ kind: "bot", actorId: "bot_keep", keyId: "rek_keep", publicKey: "pk" }] },
    } as never)
    const rekey = vi.spyOn(streamKeyCache, "rekeyStream").mockResolvedValue(undefined as never)

    const result = await revokeActorFromStream({
      workspaceId: "ws_1",
      streamId: "stream_1",
      kind: E2eActorKinds.BOT,
      actorId: "bot_gone",
      queryClient: new QueryClient(),
      owner,
    })

    expect(result).toBe("rolled")
    expect(rekey).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: "stream_1", nextGeneration: 4, ownerKeyId: "uik_owner" })
    )
    expect((await db.streams.get("stream_1"))?.e2eActors).toEqual(remaining)
  })

  it("reports the un-rolled revoke when the session is locked, so the caller can say the key still stands", async () => {
    vi.spyOn(e2eActorsApi, "revoke").mockResolvedValue({
      stream: revokedStream,
      keyRoll: { nextGeneration: 4, recipients: [{ kind: "bot", actorId: "bot_keep", keyId: "rek_keep", publicKey: "pk" }] },
    } as never)
    const rekey = vi.spyOn(streamKeyCache, "rekeyStream")

    const result = await revokeActorFromStream({
      workspaceId: "ws_1",
      streamId: "stream_1",
      kind: E2eActorKinds.BOT,
      actorId: "bot_gone",
      queryClient: new QueryClient(),
      owner: null,
    })

    expect(result).toBe("revoked-unrolled")
    expect(rekey).not.toHaveBeenCalled()
    // The actor row is gone either way — the backend already deleted it.
    expect((await db.streams.get("stream_1"))?.e2eActors).toEqual(remaining)
  })

  it("skips the roll when nobody is left holding a key", async () => {
    vi.spyOn(e2eActorsApi, "revoke").mockResolvedValue({
      stream: { id: "stream_1", workspaceId: "ws_1", e2eActors: [] } as unknown as Stream,
      keyRoll: null,
    } as never)
    const rekey = vi.spyOn(streamKeyCache, "rekeyStream")

    const result = await revokeActorFromStream({
      workspaceId: "ws_1",
      streamId: "stream_1",
      kind: E2eActorKinds.ENCLAVE,
      actorId: "enclave",
      queryClient: new QueryClient(),
      owner,
    })

    expect(result).toBe("rolled")
    expect(rekey).not.toHaveBeenCalled()
  })
})
