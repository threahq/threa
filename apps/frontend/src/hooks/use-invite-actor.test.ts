import { describe, it, expect } from "vitest"
import { StreamTypes, E2eActorKinds } from "@threa/types"
import { canInviteActor, isActorInvited } from "./use-invite-actor"
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
    parentMessageId: null,
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
    expect(canInviteActor(makeStream({ e2eActors: [{ kind: E2eActorKinds.ENCLAVE }] }), E2eActorKinds.ENCLAVE)).toBe(
      false
    )
  })

  it("allows inviting the enclave when only a bot is invited (multi-actor)", () => {
    expect(canInviteActor(makeStream({ e2eActors: [{ kind: E2eActorKinds.BOT }] }), E2eActorKinds.ENCLAVE)).toBe(true)
  })
})

describe("isActorInvited", () => {
  it("is true only when that kind is present in the actor set", () => {
    const withEnclave = makeStream({ e2eActors: [{ kind: E2eActorKinds.ENCLAVE }] })
    expect(isActorInvited(withEnclave, E2eActorKinds.ENCLAVE)).toBe(true)
    expect(isActorInvited(withEnclave, E2eActorKinds.BOT)).toBe(false)
    expect(isActorInvited(makeStream({ e2eActors: [] }), E2eActorKinds.ENCLAVE)).toBe(false)
    expect(isActorInvited(undefined, E2eActorKinds.ENCLAVE)).toBe(false)
  })

  it("detects an actor among multiple invited kinds", () => {
    const multi = makeStream({ e2eActors: [{ kind: E2eActorKinds.BOT }, { kind: E2eActorKinds.ENCLAVE }] })
    expect(isActorInvited(multi, E2eActorKinds.BOT)).toBe(true)
    expect(isActorInvited(multi, E2eActorKinds.ENCLAVE)).toBe(true)
  })
})
