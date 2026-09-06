import { describe, test, expect, spyOn, afterEach, mock } from "bun:test"
import { ConversationStatuses } from "@threahq/types"
import { ConversationRepository, type Conversation } from "../../conversations"
import { resolveEligibleConversation, loadConversationHighlight } from "./conversation-highlight"

// The resolver only threads `db` into the (spied) repository, so a dummy stands
// in for a real Querier — same fake-Querier convention as the assigner and the
// per-stream-concurrency tests.
const DB = {} as never
const WORKSPACE_ID = "ws_1"

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_x",
    workspaceId: WORKSPACE_ID,
    streamId: "chan_1",
    status: ConversationStatuses.ACTIVE,
    topicSummary: "a topic",
    ...overrides,
  } as unknown as Conversation
}

afterEach(() => mock.restore())

describe("resolveEligibleConversation — reply anchoring (roadmap 3.3)", () => {
  test("prefers the trigger's own conversation over the most-recently-active one", async () => {
    // The interleaved-topics case: the trigger was classified into the OLDER
    // topic `conv_trigger`; `conv_recent` is what was touched last. The reply
    // must anchor to the trigger's conversation, not the last-active one.
    const findPrimary = spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(
      conversation({ id: "conv_trigger" })
    )
    const findByMessageIds = spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([
      conversation({ id: "conv_recent" }),
    ])

    const result = await resolveEligibleConversation(DB, {
      workspaceId: WORKSPACE_ID,
      preferMessageId: "msg_trigger",
      windowMessageIds: ["msg_a", "msg_b"],
      isEligible: () => true,
    })

    expect(result?.id).toBe("conv_trigger")
    expect(findPrimary).toHaveBeenCalledWith(DB, WORKSPACE_ID, "msg_trigger")
    // Preferred won outright — no need to scan the window.
    expect(findByMessageIds).not.toHaveBeenCalled()
  })

  test("falls back to the most-recently-active conversation when the trigger isn't classified yet", async () => {
    // Extraction lags, so the trigger has no primary conversation on this turn.
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(null)
    // findByMessageIds orders by last_activity_at DESC, so the first is the live topic.
    spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([
      conversation({ id: "conv_recent" }),
      conversation({ id: "conv_older" }),
    ])

    const result = await resolveEligibleConversation(DB, {
      workspaceId: WORKSPACE_ID,
      preferMessageId: "msg_trigger",
      windowMessageIds: ["msg_a", "msg_b"],
      isEligible: () => true,
    })

    expect(result?.id).toBe("conv_recent")
  })

  test("skips an ineligible preferred conversation and takes the first eligible in the window", async () => {
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(conversation({ id: "conv_trigger" }))
    spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([
      conversation({ id: "conv_recent" }),
      conversation({ id: "conv_eligible" }),
    ])

    const result = await resolveEligibleConversation(DB, {
      workspaceId: WORKSPACE_ID,
      preferMessageId: "msg_trigger",
      windowMessageIds: ["msg_a"],
      isEligible: (c) => c.id === "conv_eligible",
    })

    expect(result?.id).toBe("conv_eligible")
  })

  test("resolves to null when nothing in the window is eligible", async () => {
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(null)
    spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([conversation({ id: "conv_recent" })])

    const result = await resolveEligibleConversation(DB, {
      workspaceId: WORKSPACE_ID,
      preferMessageId: "msg_trigger",
      windowMessageIds: ["msg_a"],
      isEligible: () => false,
    })

    expect(result).toBeNull()
  })

  test("resolves to null with an empty window and no preferred match", async () => {
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(null)
    const findByMessageIds = spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([])

    const result = await resolveEligibleConversation(DB, {
      workspaceId: WORKSPACE_ID,
      preferMessageId: "msg_trigger",
      windowMessageIds: [],
      isEligible: () => true,
    })

    expect(result).toBeNull()
    // Empty window short-circuits before any DB scan.
    expect(findByMessageIds).not.toHaveBeenCalled()
  })
})

describe("loadConversationHighlight — topic eligibility", () => {
  test("returns the trigger topic, ignoring a resolved or topic-less preferred conversation", async () => {
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(
      conversation({ id: "conv_trigger", topicSummary: "  Deploy cadence  " })
    )

    const topic = await loadConversationHighlight(DB, {
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "msg_trigger",
      windowMessageIds: ["msg_a"],
    })

    expect(topic).toBe("Deploy cadence")
  })

  test("skips a resolved preferred conversation and falls to an active topic in the window", async () => {
    spyOn(ConversationRepository, "findPrimaryByMessageId").mockResolvedValue(
      conversation({ id: "conv_trigger", status: ConversationStatuses.RESOLVED, topicSummary: "old" })
    )
    spyOn(ConversationRepository, "findByMessageIds").mockResolvedValue([
      conversation({ id: "conv_live", topicSummary: "live topic" }),
    ])

    const topic = await loadConversationHighlight(DB, {
      workspaceId: WORKSPACE_ID,
      triggerMessageId: "msg_trigger",
      windowMessageIds: ["msg_a"],
    })

    expect(topic).toBe("live topic")
  })
})
