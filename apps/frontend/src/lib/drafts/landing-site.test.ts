import { describe, it, expect } from "vitest"
import { StreamTypes } from "@threa/types"
import { resolveDraftLandingSite, type DraftLandingContext, type LandingSiteBoardPost } from "./landing-site"

function post(overrides: {
  streamId: string
  messageIds?: string[]
  openingMessageId?: string | null
  recentStreamIds?: string[]
}): LandingSiteBoardPost {
  return {
    conversation: { streamId: overrides.streamId, messageIds: overrides.messageIds ?? ["msg_1"] },
    openingMessage: overrides.openingMessageId === undefined ? { id: "msg_1" } : null,
    recentMessages: (overrides.recentStreamIds ?? []).map((streamId) => ({ streamId })),
  }
}

function context(
  streams: Record<string, string>,
  posts: Record<string, LandingSiteBoardPost> = {}
): DraftLandingContext {
  return {
    streamTypeById: new Map(Object.entries(streams)),
    boardPostByConversationId: new Map(Object.entries(posts)),
  }
}

describe("resolveDraftLandingSite", () => {
  it("lands a stream scope flat in that stream", () => {
    expect(resolveDraftLandingSite("stream:stream_1", context({ stream_1: StreamTypes.CHANNEL }))).toEqual({
      kind: "flat",
      streamId: "stream_1",
    })
  })

  it("lands a thread stream's scope flat in the thread stream", () => {
    expect(resolveDraftLandingSite("stream:stream_t", context({ stream_t: StreamTypes.THREAD }))).toEqual({
      kind: "flat",
      streamId: "stream_t",
    })
  })

  it("lands a scratchpad scope flat in the scratchpad", () => {
    expect(resolveDraftLandingSite("stream:draft_9", context({}))).toEqual({ kind: "flat", streamId: "draft_9" })
  })

  it("lands a board reply flat in the conversation's last-active stream", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_1: post({ streamId: "stream_1", messageIds: ["m1", "m2"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "flat", streamId: "stream_1" })
  })

  it("follows a conversation that moved into a thread", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_1: post({ streamId: "stream_1", messageIds: ["m1", "m2"], recentStreamIds: ["stream_1", "stream_t"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "flat", streamId: "stream_t" })
  })

  it("nests a reply to a lone channel conversation (planBoardReply converts it to a thread)", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_1: post({ streamId: "stream_1", messageIds: ["m1"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "nested" })
  })

  it("nests a reply to a lone DM conversation", () => {
    const ctx = context({ stream_d: StreamTypes.DM }, { conv_d: post({ streamId: "stream_d", messageIds: ["m1"] }) })
    expect(resolveDraftLandingSite("board:reply:conv_d", ctx)).toEqual({ kind: "nested" })
  })

  it("lands the same conversation flat once it has two messages", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_1: post({ streamId: "stream_1", messageIds: ["m1", "m2"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "flat", streamId: "stream_1" })
  })

  it("lands a lone conversation flat when its opener is gone (nothing to thread off)", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_1: post({ streamId: "stream_1", messageIds: ["m1"], openingMessageId: null }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "flat", streamId: "stream_1" })
  })

  it("lands a lone scratchpad conversation flat (only channels and DMs thread-convert)", () => {
    const ctx = context(
      { stream_s: StreamTypes.SCRATCHPAD },
      { conv_s: post({ streamId: "stream_s", messageIds: ["m1"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_s", ctx)).toEqual({ kind: "flat", streamId: "stream_s" })
  })

  it("lands a lone thread conversation flat", () => {
    const ctx = context(
      { stream_t: StreamTypes.THREAD },
      { conv_t: post({ streamId: "stream_t", messageIds: ["m1"] }) }
    )
    expect(resolveDraftLandingSite("board:reply:conv_t", ctx)).toEqual({ kind: "flat", streamId: "stream_t" })
  })

  it("nests thread, branch-reply and sub-topic scopes regardless of cache", () => {
    const ctx = context(
      { stream_1: StreamTypes.CHANNEL },
      { conv_b: post({ streamId: "stream_1", messageIds: ["m1", "m2"] }) }
    )
    expect(resolveDraftLandingSite("thread:msg_1", ctx)).toEqual({ kind: "nested" })
    expect(resolveDraftLandingSite("board:branch-reply:conv_b", ctx)).toEqual({ kind: "nested" })
    expect(resolveDraftLandingSite("board:subtopic:stream_1:msg_1", ctx)).toEqual({ kind: "nested" })
  })

  it("returns unknown for a board reply whose conversation isn't cached", () => {
    expect(resolveDraftLandingSite("board:reply:conv_missing", context({ stream_1: StreamTypes.CHANNEL }))).toEqual({
      kind: "unknown",
    })
  })

  it("returns unknown for an unparseable scope", () => {
    expect(resolveDraftLandingSite("nonsense", context({}))).toEqual({ kind: "unknown" })
    expect(resolveDraftLandingSite("stream:", context({}))).toEqual({ kind: "unknown" })
  })

  it("does not assume the anchor's type when the host stream isn't cached", () => {
    const ctx = context({}, { conv_1: post({ streamId: "stream_x", messageIds: ["m1"] }) })
    expect(resolveDraftLandingSite("board:reply:conv_1", ctx)).toEqual({ kind: "flat", streamId: "stream_x" })
  })
})
