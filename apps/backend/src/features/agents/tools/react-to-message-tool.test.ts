import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { createReactToMessageTool } from "./react-to-message-tool"
import { MessageRepository, type Message } from "../../messaging"
import type { ReactionToolDeps, WorkspaceToolDeps } from "./tool-deps"

afterEach(() => {
  mock.restore()
})

function makeWorkspace(overrides?: Partial<WorkspaceToolDeps>): WorkspaceToolDeps {
  return {
    db: {} as WorkspaceToolDeps["db"],
    workspaceId: "workspace_test",
    accessibleStreamIds: ["stream_ok"],
    invokingUserId: "usr_test",
    searchService: {} as WorkspaceToolDeps["searchService"],
    storage: {} as WorkspaceToolDeps["storage"],
    attachmentService: {} as WorkspaceToolDeps["attachmentService"],
    memoExplorer: {} as WorkspaceToolDeps["memoExplorer"],
    ...overrides,
  }
}

type ReactionArgs = { streamId: string; messageId: string; emoji: string }

function makeReactions() {
  const addReaction = mock(async (_params: ReactionArgs) => ({ id: "msg_1" }))
  const removeReaction = mock(async (_params: ReactionArgs) => ({ id: "msg_1" }))
  return { reactions: { addReaction, removeReaction } as ReactionToolDeps, addReaction, removeReaction }
}

function fakeMessage(overrides?: Partial<Message>): Message {
  return {
    id: "msg_1",
    streamId: "stream_ok",
    deletedAt: null,
    reactions: {},
    ...overrides,
  } as Message
}

function mockFindById(message: Message | null) {
  spyOn(MessageRepository, "findByIdsInWorkspace").mockResolvedValue(new Map(message ? [[message.id, message]] : []))
}

describe("react_to_message tool", () => {
  it("adds a reaction to an accessible message and reports success", async () => {
    mockFindById(fakeMessage())
    const { reactions, addReaction, removeReaction } = makeReactions()
    const tool = createReactToMessageTool(makeWorkspace(), reactions)

    const result = await tool.config.execute({ messageId: "msg_1", emoji: "🔥" }, { toolCallId: "tc_1" })

    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(true)
    expect(parsed.action).toBe("add")
    expect(addReaction).toHaveBeenCalledTimes(1)
    expect(addReaction.mock.calls[0][0]).toMatchObject({ streamId: "stream_ok", messageId: "msg_1" })
    expect(typeof addReaction.mock.calls[0][0].emoji).toBe("string")
    expect(removeReaction).not.toHaveBeenCalled()
  })

  it("removes a reaction when action is 'remove'", async () => {
    mockFindById(fakeMessage())
    const { reactions, addReaction, removeReaction } = makeReactions()
    const tool = createReactToMessageTool(makeWorkspace(), reactions)

    const result = await tool.config.execute(
      { messageId: "msg_1", emoji: "🔥", action: "remove" },
      { toolCallId: "tc_1" }
    )

    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(true)
    expect(parsed.action).toBe("remove")
    expect(removeReaction).toHaveBeenCalledTimes(1)
    expect(addReaction).not.toHaveBeenCalled()
  })

  it("refuses to react to a message outside the persona's accessible streams", async () => {
    mockFindById(fakeMessage({ streamId: "stream_secret" }))
    const { reactions, addReaction } = makeReactions()
    const tool = createReactToMessageTool(makeWorkspace({ accessibleStreamIds: ["stream_ok"] }), reactions)

    const result = await tool.config.execute({ messageId: "msg_1", emoji: "🔥" }, { toolCallId: "tc_1" })

    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(false)
    expect(addReaction).not.toHaveBeenCalled()
  })

  it("reports not found for an unknown or deleted message", async () => {
    const { reactions, addReaction } = makeReactions()
    const tool = createReactToMessageTool(makeWorkspace(), reactions)

    mockFindById(null)
    const missing = JSON.parse(
      (await tool.config.execute({ messageId: "msg_x", emoji: "🔥" }, { toolCallId: "tc_1" })).output
    )
    expect(missing.ok).toBe(false)

    mockFindById(fakeMessage({ deletedAt: new Date() }))
    const deleted = JSON.parse(
      (await tool.config.execute({ messageId: "msg_1", emoji: "🔥" }, { toolCallId: "tc_2" })).output
    )
    expect(deleted.ok).toBe(false)

    expect(addReaction).not.toHaveBeenCalled()
  })

  it("rejects an unrecognized emoji without touching the message", async () => {
    const findSpy = spyOn(MessageRepository, "findByIdsInWorkspace")
    const { reactions, addReaction } = makeReactions()
    const tool = createReactToMessageTool(makeWorkspace(), reactions)

    const result = await tool.config.execute(
      { messageId: "msg_1", emoji: "definitely-not-an-emoji" },
      { toolCallId: "tc_1" }
    )

    const parsed = JSON.parse(result.output)
    expect(parsed.ok).toBe(false)
    expect(findSpy).not.toHaveBeenCalled()
    expect(addReaction).not.toHaveBeenCalled()
  })
})
