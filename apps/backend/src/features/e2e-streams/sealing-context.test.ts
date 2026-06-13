import { afterEach, describe, expect, it, spyOn } from "bun:test"
import type { Querier } from "../../db"
import { E2eStreamsRepository } from "./repository"
import { E2eStreamActorsRepository } from "./actor-repository"
import { resolveSealingContext } from "./sealing-context"

const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Querier
const params = { workspaceId: "ws_1", streamId: "stream_01" }

describe("resolveSealingContext", () => {
  afterEach(() => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockRestore()
    spyOn(E2eStreamActorsRepository, "listForStream").mockRestore()
  })

  it("short-circuits on a plaintext stream without querying actors", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const listActors = spyOn(E2eStreamActorsRepository, "listForStream")

    const context = await resolveSealingContext(db, { ...params, actor: { kind: "bot", botId: "bot_pi" } })

    expect(context).toEqual({ streamIsE2e: false, actorHasGrant: false, externalSealedDelivery: false })
    expect(listActors).not.toHaveBeenCalled()
  })

  it("the companion never holds a grant, even on an E2E stream", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    const listActors = spyOn(E2eStreamActorsRepository, "listForStream")

    const context = await resolveSealingContext(db, { ...params, actor: { kind: "companion" } })

    expect(context).toEqual({ streamIsE2e: true, actorHasGrant: false, externalSealedDelivery: false })
    expect(listActors).not.toHaveBeenCalled()
  })

  it("the enclave's grant is any enclave actor row on the stream", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([
      { kind: "enclave", actorId: "enclave", keyId: null },
    ])

    const context = await resolveSealingContext(db, { ...params, actor: { kind: "enclave" } })

    expect(context).toEqual({ streamIsE2e: true, actorHasGrant: true, externalSealedDelivery: false })
  })

  it("a bot's grant is pinned to its own bot id — another bot's invite does not count", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(true)
    spyOn(E2eStreamActorsRepository, "listForStream").mockResolvedValue([
      { kind: "enclave", actorId: "enclave", keyId: null },
      { kind: "bot", actorId: "bot_other", keyId: "bkey_01" },
    ])

    const denied = await resolveSealingContext(db, { ...params, actor: { kind: "bot", botId: "bot_pi" } })
    expect(denied).toEqual({ streamIsE2e: true, actorHasGrant: false, externalSealedDelivery: false })

    const granted = await resolveSealingContext(db, { ...params, actor: { kind: "bot", botId: "bot_other" } })
    expect(granted).toEqual({ streamIsE2e: true, actorHasGrant: true, externalSealedDelivery: false })
  })
})
