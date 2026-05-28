import { describe, it, expect } from "vitest"
import { StreamTypes, E2eInvitedAgentKinds } from "@threa/types"
import { canInviteEnclave, isEnclaveInvited } from "./use-invite-enclave"
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
    e2eInvitedAgentKind: E2eInvitedAgentKinds.NONE,
    ...overrides,
  }
}

describe("canInviteEnclave", () => {
  it("allows an unlocked E2E scratchpad with no invited agent", () => {
    expect(canInviteEnclave(makeStream())).toBe(true)
  })

  it("rejects when undefined", () => {
    expect(canInviteEnclave(undefined)).toBe(false)
  })

  it("rejects non-scratchpad streams", () => {
    expect(canInviteEnclave(makeStream({ type: StreamTypes.CHANNEL }))).toBe(false)
  })

  it("rejects drafts", () => {
    expect(canInviteEnclave(makeStream({ isDraft: true }))).toBe(false)
  })

  it("rejects plaintext scratchpads", () => {
    expect(canInviteEnclave(makeStream({ e2eEnabled: false }))).toBe(false)
  })

  it("rejects when the enclave is already invited", () => {
    expect(canInviteEnclave(makeStream({ e2eInvitedAgentKind: E2eInvitedAgentKinds.ENCLAVE }))).toBe(false)
  })
})

describe("isEnclaveInvited", () => {
  it("is true only for the enclave kind", () => {
    expect(isEnclaveInvited(makeStream({ e2eInvitedAgentKind: E2eInvitedAgentKinds.ENCLAVE }))).toBe(true)
    expect(isEnclaveInvited(makeStream({ e2eInvitedAgentKind: E2eInvitedAgentKinds.BOT }))).toBe(false)
    expect(isEnclaveInvited(makeStream({ e2eInvitedAgentKind: E2eInvitedAgentKinds.NONE }))).toBe(false)
    expect(isEnclaveInvited(undefined)).toBe(false)
  })
})
