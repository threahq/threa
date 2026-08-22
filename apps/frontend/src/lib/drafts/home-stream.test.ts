import { describe, it, expect } from "vitest"
import {
  isDraftInHostPile,
  isTopLevelDraftScope,
  resolveDraftConversation,
  resolveDraftHomeStream,
  type DraftPileContext,
} from "./home-stream"
import { asideDraftScope, newAsideDraftScope, parseAsideDraftScope } from "./aside-scope"

const context: DraftPileContext = {
  streamById: new Map([
    ["stream_s", { rootStreamId: null }],
    ["stream_t", { rootStreamId: "stream_s" }],
    ["stream_tc", { rootStreamId: "stream_s", parentAnchorId: "msg_c" }],
    ["stream_other", { rootStreamId: null }],
  ]),
  boardPostByConversationId: new Map([
    ["conv_s", { conversation: { streamId: "stream_s" } }],
    ["conv_t", { conversation: { streamId: "stream_t" } }],
    ["conv_c", { conversation: { streamId: "stream_s" } }],
    ["conv_d", { conversation: { streamId: "stream_s" } }],
    ["conv_branch", { conversation: { streamId: "stream_tc" } }],
  ]),
  threadAnchorStreamById: new Map([
    ["msg_1", { streamId: "stream_t" }],
    ["msg_c", { streamId: "stream_s" }],
    ["msg_loose", { streamId: "stream_s" }],
  ]),
  conversationIdByMessageId: new Map([
    ["msg_c", "conv_c"],
    ["msg_d", "conv_d"],
  ]),
  parentConversationIdByBranchId: new Map([["conv_branch", "conv_c"]]),
}

describe("resolveDraftHomeStream", () => {
  it("resolves every scope under one root to that root", () => {
    expect(resolveDraftHomeStream("stream:stream_s", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("stream:stream_t", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("thread:msg_1", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("board:reply:conv_s", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("board:reply:conv_t", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("board:branch-reply:conv_t", context)).toBe("stream_s")
    expect(resolveDraftHomeStream("board:subtopic:stream_t:msg_9", context)).toBe("stream_s")
  })

  it("keeps another root separate", () => {
    expect(resolveDraftHomeStream("stream:stream_other", context)).toBe("stream_other")
  })

  it("treats an uncached stream as its own root (a scratchpad has no row)", () => {
    expect(resolveDraftHomeStream("stream:draft_9", context)).toBe("draft_9")
  })

  it("returns null for anything unresolvable", () => {
    expect(resolveDraftHomeStream("board:reply:conv_missing", context)).toBeNull()
    expect(resolveDraftHomeStream("thread:msg_missing", context)).toBeNull()
    expect(resolveDraftHomeStream("stream:", context)).toBeNull()
    expect(resolveDraftHomeStream("nonsense", context)).toBeNull()
  })
})

describe("resolveDraftConversation", () => {
  it("names the conversation a scope's message would belong to", () => {
    expect(resolveDraftConversation("board:reply:conv_c", context)).toBe("conv_c")
    expect(resolveDraftConversation("board:branch-reply:conv_branch", context)).toBe("conv_c")
    expect(resolveDraftConversation("board:subtopic:stream_s:msg_c", context)).toBe("conv_c")
    expect(resolveDraftConversation("thread:msg_c", context)).toBe("conv_c")
    expect(resolveDraftConversation("stream:stream_tc", context)).toBe("conv_c")
  })

  it("returns null for a top-level scope and for an unresolvable owner", () => {
    expect(resolveDraftConversation("stream:stream_s", context)).toBeNull()
    expect(resolveDraftConversation("thread:msg_loose", context)).toBeNull()
    expect(resolveDraftConversation("nonsense", context)).toBeNull()
  })

  it("falls back to the branch itself when its parent is not cached", () => {
    expect(resolveDraftConversation("board:branch-reply:conv_orphan", context)).toBe("conv_orphan")
  })
})

describe("isTopLevelDraftScope", () => {
  it("is true for a root stream and a conversation reply, false below them", () => {
    expect(isTopLevelDraftScope("stream:stream_s", context)).toBe(true)
    expect(isTopLevelDraftScope("board:reply:conv_c", context)).toBe(true)
    expect(isTopLevelDraftScope("stream:stream_t", context)).toBe(false)
    expect(isTopLevelDraftScope("thread:msg_c", context)).toBe(false)
    expect(isTopLevelDraftScope("board:subtopic:stream_s:msg_c", context)).toBe(false)
  })
})

describe("isDraftInHostPile", () => {
  it("takes the own, same-conversation, top-level-draft and top-level-host routes", () => {
    expect(isDraftInHostPile("thread:msg_c", "thread:msg_c", context)).toBe(true)
    expect(isDraftInHostPile("board:reply:conv_c", "thread:msg_c", context)).toBe(true)
    expect(isDraftInHostPile("thread:msg_loose", "stream:stream_s", context)).toBe(true)
    expect(isDraftInHostPile("stream:stream_s", "thread:msg_c", context)).toBe(true)
  })

  it("keeps one conversation's drafts out of another's pile", () => {
    expect(isDraftInHostPile("board:reply:conv_d", "thread:msg_c", context)).toBe(false)
    expect(isDraftInHostPile("board:reply:conv_d", "board:reply:conv_c", context)).toBe(false)
  })

  it("leaves a conversation-less thread draft in its own pile only", () => {
    expect(isDraftInHostPile("stream:stream_s", "thread:msg_loose", context)).toBe(false)
    expect(isDraftInHostPile("board:reply:conv_c", "thread:msg_loose", context)).toBe(false)
  })

  it("never matches two unknowns, and never crosses roots", () => {
    expect(isDraftInHostPile("thread:msg_loose", "thread:msg_missing", context)).toBe(false)
    expect(isDraftInHostPile("stream:stream_other", "stream:stream_s", context)).toBe(false)
  })
})

describe("aside draft scopes", () => {
  const asideScope = asideDraftScope("stream_aside", "draft_1")

  it("round-trips a scope and rejects a malformed one", () => {
    expect(parseAsideDraftScope(asideScope)).toEqual({ asideId: "stream_aside", draftId: "draft_1" })
    expect(parseAsideDraftScope("aside:stream_aside")).toBeNull()
    expect(parseAsideDraftScope("aside:stream_aside:draft_1:extra")).toBeNull()
    expect(parseAsideDraftScope("stream:stream_aside")).toBeNull()
    expect(newAsideDraftScope("stream_aside")).toMatch(/^aside:stream_aside:draft_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("has no home stream, so it never enters a host's pile", () => {
    expect(resolveDraftHomeStream(asideScope, context)).toBeNull()
    expect(isTopLevelDraftScope(asideScope, context)).toBe(false)
    expect(isDraftInHostPile("stream:stream_s", asideScope, context)).toBe(false)
    expect(isDraftInHostPile("board:reply:conv_c", asideScope, context)).toBe(false)
    expect(isDraftInHostPile("thread:msg_c", asideScope, context)).toBe(false)
  })

  it("still hosts its own scope, so the aside's own editor loads it", () => {
    expect(isDraftInHostPile(asideScope, asideScope, context)).toBe(true)
    expect(isDraftInHostPile(asideScope, "stream:stream_s", context)).toBe(false)
  })
})
