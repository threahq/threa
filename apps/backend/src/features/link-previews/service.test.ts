import { describe, test, expect, spyOn, afterEach, beforeAll, afterAll, mock } from "bun:test"
import type { Pool } from "pg"
import { LinkPreviewService } from "./service"
import { LinkPreviewRepository, type LinkPreview } from "./repository"
import { MessageRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import { ConversationRepository, type Conversation } from "../conversations"
import { SearchRepository } from "../search"
import type { StreamService } from "../streams"
import { StreamMemberRepository } from "../streams"
import type { MemoExplorerService } from "../memos"
import type { DelegationService } from "../delegations"

/** The exact shape `tryAccess` resolves to, so a drift in the contract breaks here. */
type AccessibleStream = NonNullable<Awaited<ReturnType<StreamService["tryAccess"]>>>

const WORKSPACE_ID = "ws_self"
const VIEWER_ID = "user_viewer"

function makePreview(overrides: Partial<LinkPreview>): LinkPreview {
  return {
    id: "lp_1",
    workspaceId: WORKSPACE_ID,
    url: "https://app.threa.io/w/ws_self/s/stream_1",
    normalizedUrl: "https://app.threa.io/w/ws_self/s/stream_1",
    title: null,
    description: null,
    imageUrl: null,
    faviconUrl: null,
    siteName: null,
    contentType: "stream_link",
    status: "completed",
    previewType: null,
    previewData: null,
    targetWorkspaceId: WORKSPACE_ID,
    targetStreamId: "stream_1",
    targetMessageId: null,
    targetMemoId: null,
    targetConversationId: null,
    targetDelegationId: null,
    fetchedAt: null,
    refreshVersion: 0,
    refreshEtag: null,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeStream(overrides: Partial<AccessibleStream> = {}): AccessibleStream {
  return {
    id: "stream_1",
    workspaceId: WORKSPACE_ID,
    type: "channel",
    displayName: null,
    slug: "design",
    description: null,
    visibility: "public",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "user_owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  } as AccessibleStream
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_1",
    streamId: "stream_1",
    workspaceId: WORKSPACE_ID,
    messageIds: ["msg_1", "msg_2", "msg_3"],
    participantIds: ["user_a", "user_b"],
    secondaryMessageIds: [],
    topicSummary: "Auth redesign",
    summary: "Deciding how auth flows through the router.",
    completenessScore: 3,
    confidence: 0.8,
    status: "active",
    parentConversationId: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeService(
  streamService: Partial<StreamService>,
  memoExplorerService: Partial<MemoExplorerService>,
  delegationService: Partial<DelegationService> = {}
) {
  return new LinkPreviewService({
    pool: {} as Pool,
    streamService: streamService as StreamService,
    memoExplorerService: memoExplorerService as MemoExplorerService,
    delegationService: delegationService as DelegationService,
  })
}

afterEach(() => {
  mock.restore()
})

describe("LinkPreviewService.resolveInAppLink", () => {
  test("returns cross_workspace for a stream link in another workspace without inspecting it", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "stream_link", targetWorkspaceId: "ws_other" })
    )
    const tryAccess = spyOn({ tryAccess: async () => null }, "tryAccess")
    const service = makeService({ tryAccess: tryAccess as never }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({ kind: "stream", accessTier: "cross_workspace" })
    expect(tryAccess).not.toHaveBeenCalled()
  })

  test("returns private when the viewer cannot access the target stream", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(makePreview({ contentType: "stream_link" }))
    const service = makeService({ tryAccess: async () => null }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({ kind: "stream", accessTier: "private" })
  })

  test("returns full stream data when the viewer has access", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(makePreview({ contentType: "stream_link" }))
    const service = makeService(
      { tryAccess: async () => makeStream({ slug: "design", description: "Where design happens" }) },
      {}
    )

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({
      kind: "stream",
      accessTier: "full",
      streamName: "design",
      streamType: "channel",
      visibility: "public",
      description: "Where design happens",
    })
  })

  test("returns full memo data gated by accessible streams", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_1" })
    )
    spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockResolvedValue(["stream_1"])
    const getById = spyOn(
      {
        getById: async () => ({
          memo: { title: "How auth works", abstract: "Auth flows through the router.", knowledgeType: "decision" },
          sourceStream: { id: "stream_1", type: "channel", name: "eng" },
        }),
      },
      "getById"
    )
    const service = makeService({}, { getById: getById as never })

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({
      kind: "memo",
      accessTier: "full",
      title: "How auth works",
      abstract: "Auth flows through the router.",
      knowledgeType: "decision",
      sourceStreamName: "eng",
    })
  })

  test("returns private without reading the memo when the viewer has no accessible streams", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_1" })
    )
    spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockResolvedValue([])
    const getById = spyOn({ getById: async () => null }, "getById")
    const service = makeService({}, { getById: getById as never })

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({ kind: "memo", accessTier: "private" })
    // No memo-row read when there's nothing the viewer could access — no existence side-channel.
    expect(getById).not.toHaveBeenCalled()
  })

  test("returns private when the memo's source stream is not accessible", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_1" })
    )
    spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockResolvedValue(["stream_other"])
    const service = makeService({}, { getById: async () => null })

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({ kind: "memo", accessTier: "private" })
  })

  test("returns cross_workspace for a conversation link in another workspace without inspecting it", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "conversation_link",
        targetStreamId: null,
        targetWorkspaceId: "ws_other",
        targetConversationId: "conv_1",
      })
    )
    const findById = spyOn(ConversationRepository, "findById").mockResolvedValue(makeConversation())
    const tryAccess = spyOn({ tryAccess: async () => null }, "tryAccess")
    const service = makeService({ tryAccess: tryAccess as never }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({ kind: "conversation", accessTier: "cross_workspace" })
    expect(findById).not.toHaveBeenCalled()
    expect(tryAccess).not.toHaveBeenCalled()
  })

  test("returns private when the conversation is missing", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "conversation_link", targetStreamId: null, targetConversationId: "conv_1" })
    )
    spyOn(ConversationRepository, "findById").mockResolvedValue(null)
    const service = makeService({ tryAccess: async () => makeStream() }, {})

    expect(await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")).toEqual({
      kind: "conversation",
      accessTier: "private",
    })
  })

  test("returns private when the viewer cannot access the conversation's anchor stream", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "conversation_link", targetStreamId: null, targetConversationId: "conv_1" })
    )
    spyOn(ConversationRepository, "findById").mockResolvedValue(makeConversation())
    const service = makeService({ tryAccess: async () => null }, {})

    expect(await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")).toEqual({
      kind: "conversation",
      accessTier: "private",
    })
  })

  test("returns full conversation metadata when the viewer has access", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({ contentType: "conversation_link", targetStreamId: null, targetConversationId: "conv_1" })
    )
    spyOn(ConversationRepository, "findById").mockResolvedValue(
      makeConversation({ status: "resolved", messageIds: ["msg_1", "msg_2", "msg_3", "msg_4"] })
    )
    const service = makeService({ tryAccess: async () => makeStream({ slug: "eng", type: "channel" }) }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({
      kind: "conversation",
      accessTier: "full",
      topicSummary: "Auth redesign",
      summary: "Deciding how auth flows through the router.",
      status: "resolved",
      messageCount: 4,
      participantIds: ["user_a", "user_b"],
      streamName: "eng",
      streamType: "channel",
    })
  })

  test("returns null for a non-existent preview", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(null)
    const service = makeService({}, {})

    expect(await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_missing")).toBeNull()
  })

  test("message link still resolves full content for an accessible stream", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "message_link",
        targetMessageId: "msg_1",
        url: "https://app.threa.io/w/ws_self/s/stream_1?m=msg_1",
      })
    )
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_1",
      authorType: "user",
      authorId: "user_author",
      contentMarkdown: "Hello there",
      deletedAt: null,
    } as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Author", avatarUrl: null } as never)
    const service = makeService({ tryAccess: async () => makeStream({ slug: "general" }) }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toMatchObject({
      kind: "message",
      accessTier: "full",
      authorName: "Author",
      contentPreview: "Hello there",
      streamName: "general",
      streamType: "channel",
    })
  })

  test("strips markdown before truncating so a link cut at the boundary never leaks literal syntax", async () => {
    // A link whose markdown spans the snippet cut: a raw slice would drop the
    // closing `](url)` and ship the literal "[label…". Stripping first leaves
    // clean text to truncate, so no bracket or url leaks to the card.
    const label = "Kristoffer Östlund"
    const longContent = `[${label}](https://app.threa.io/w/ws_self/s/stream_1?m=msg_2) ${"x".repeat(300)}`
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "message_link",
        targetMessageId: "msg_1",
        url: "https://app.threa.io/w/ws_self/s/stream_1?m=msg_1",
      })
    )
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_1",
      authorType: "user",
      authorId: "user_author",
      contentMarkdown: longContent,
      deletedAt: null,
    } as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Author", avatarUrl: null } as never)
    const service = makeService({ tryAccess: async () => makeStream({ slug: "general" }) }, {})

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    const preview = (result as { contentPreview?: string }).contentPreview ?? ""
    expect(preview.startsWith(`${label} `)).toBe(true)
    expect(preview).not.toContain("](")
    expect(preview).not.toContain("https://")
    // Truncated to the 200-char cap plus the single ellipsis, not the full tail.
    expect(preview.length).toBeLessThanOrEqual(201)
  })

  test("a DM message resolves the non-author participant as the recipient", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "message_link",
        targetStreamId: "stream_dm",
        targetMessageId: "msg_1",
        url: "https://app.threa.io/w/ws_self/s/stream_dm?m=msg_1",
      })
    )
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_dm",
      authorType: "user",
      authorId: "user_pierre",
      contentMarkdown: "hey",
      deletedAt: null,
    } as never)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([
      { streamId: "stream_dm", memberId: "user_pierre" },
      { streamId: "stream_dm", memberId: VIEWER_ID },
    ] as never)
    spyOn(UserRepository, "findById").mockImplementation((async (_pool: unknown, _ws: unknown, id: string) =>
      id === "user_pierre"
        ? { name: "Pierre Boberg", avatarUrl: null }
        : { name: "Kristoffer Remback", avatarUrl: null }) as never)
    const service = makeService(
      { tryAccess: async () => makeStream({ id: "stream_dm", type: "dm", slug: null, displayName: null }) },
      {}
    )

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toMatchObject({
      kind: "message",
      accessTier: "full",
      authorName: "Pierre Boberg",
      streamType: "dm",
      recipientName: "Kristoffer Remback",
    })
  })

  test("a persona-authored DM names the other participant, not the viewer", async () => {
    // The author isn't a DM member, so the recipient must skip the viewer and
    // name the real other participant rather than resolving to "You".
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "message_link",
        targetStreamId: "stream_dm",
        targetMessageId: "msg_1",
        url: "https://app.threa.io/w/ws_self/s/stream_dm?m=msg_1",
      })
    )
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_dm",
      authorType: "persona",
      authorId: "persona_assistant",
      contentMarkdown: "drafted for you",
      deletedAt: null,
    } as never)
    spyOn(StreamMemberRepository, "list").mockResolvedValue([
      { streamId: "stream_dm", memberId: VIEWER_ID },
      { streamId: "stream_dm", memberId: "user_pierre" },
    ] as never)
    spyOn(UserRepository, "findById").mockImplementation((async (_pool: unknown, _ws: unknown, id: string) =>
      id === "user_pierre" ? { name: "Pierre Boberg", avatarUrl: null } : null) as never)
    const service = makeService(
      { tryAccess: async () => makeStream({ id: "stream_dm", type: "dm", slug: null, displayName: null }) },
      {}
    )

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toMatchObject({
      kind: "message",
      accessTier: "full",
      streamType: "dm",
      recipientName: "Pierre Boberg",
    })
  })
})

describe("LinkPreviewService.getPreviewsForMessages", () => {
  test("bakes per-viewer in-app data onto in-app previews but not web previews", async () => {
    const messagePreview = makePreview({
      id: "lp_inapp",
      contentType: "message_link",
      targetStreamId: "stream_1",
      targetMessageId: "msg_target",
      url: "https://app.threa.io/w/ws_self/s/stream_1?m=msg_target",
    })
    const webPreview = makePreview({
      id: "lp_web",
      contentType: "website",
      targetWorkspaceId: null,
      targetStreamId: null,
      url: "https://example.com/blog",
    })
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(
      new Map([["msg_1", [messagePreview, webPreview]]]) as never
    )
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_target",
      streamId: "stream_1",
      authorType: "user",
      authorId: "user_author",
      contentMarkdown: "Hello there",
      deletedAt: null,
    } as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Author", avatarUrl: null } as never)
    const service = makeService({ tryAccess: async () => makeStream({ slug: "general" }) }, {})

    const result = await service.getPreviewsForMessages(WORKSPACE_ID, VIEWER_ID, ["msg_1"])

    const previews = result.get("msg_1")!
    expect(previews.find((p) => p.id === "lp_inapp")!.inAppData).toMatchObject({
      kind: "message",
      accessTier: "full",
      authorName: "Author",
      contentPreview: "Hello there",
      streamType: "channel",
    })
    // A plain web preview carries no in-app resolve.
    expect(previews.find((p) => p.id === "lp_web")!.inAppData).toBeUndefined()
  })

  test("bakes the per-viewer private tier when the viewer cannot access the target", async () => {
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        ["msg_1", [makePreview({ id: "lp_inapp", contentType: "stream_link", targetStreamId: "stream_secret" })]],
      ]) as never
    )
    const service = makeService({ tryAccess: async () => null }, {})

    const result = await service.getPreviewsForMessages(WORKSPACE_ID, VIEWER_ID, ["msg_1"])

    expect(result.get("msg_1")![0].inAppData).toEqual({ kind: "stream", accessTier: "private" })
  })

  test("a single resolve failure leaves that preview unbaked without failing the page", async () => {
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        [
          "msg_1",
          [
            makePreview({ id: "lp_ok", contentType: "stream_link", targetStreamId: "stream_ok" }),
            makePreview({ id: "lp_bad", contentType: "stream_link", targetStreamId: "stream_err" }),
          ],
        ],
      ]) as never
    )
    const service = makeService(
      {
        tryAccess: (async (streamId: string) => {
          if (streamId === "stream_err") throw new Error("boom")
          return makeStream({ id: "stream_ok", slug: "general" })
        }) as never,
      },
      {}
    )

    const previews = (await service.getPreviewsForMessages(WORKSPACE_ID, VIEWER_ID, ["msg_1"])).get("msg_1")!

    expect(previews.find((p) => p.id === "lp_ok")!.inAppData).toMatchObject({ kind: "stream", accessTier: "full" })
    expect(previews.find((p) => p.id === "lp_bad")!.inAppData).toBeUndefined()
  })

  test("resolves the viewer's accessible streams once for multiple memo previews", async () => {
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        [
          "msg_1",
          [
            makePreview({ id: "lp_a", contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_a" }),
            makePreview({ id: "lp_b", contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_b" }),
          ],
        ],
      ]) as never
    )
    const accessibleSpy = spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockResolvedValue(["stream_1"])
    const service = makeService(
      {},
      {
        getById: (async (_ws: string, memoId: string) => ({
          memo: { title: memoId, abstract: "abstract", knowledgeType: "decision" },
          sourceStream: { id: "stream_1", type: "channel", name: "eng" },
        })) as never,
      }
    )

    const previews = (await service.getPreviewsForMessages(WORKSPACE_ID, VIEWER_ID, ["msg_1"])).get("msg_1")!

    expect(previews.every((p) => p.inAppData?.kind === "memo")).toBe(true)
    expect(accessibleSpy).toHaveBeenCalledTimes(1)
  })

  test("a failed memo-access lookup leaves memo previews unbaked without failing the page", async () => {
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(
      new Map([
        [
          "msg_1",
          [
            makePreview({ id: "lp_memo", contentType: "memo_link", targetStreamId: null, targetMemoId: "memo_a" }),
            makePreview({ id: "lp_stream", contentType: "stream_link", targetStreamId: "stream_ok" }),
          ],
        ],
      ]) as never
    )
    spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockRejectedValue(new Error("db down"))
    const service = makeService({ tryAccess: async () => makeStream({ id: "stream_ok", slug: "general" }) }, {})

    const previews = (await service.getPreviewsForMessages(WORKSPACE_ID, VIEWER_ID, ["msg_1"])).get("msg_1")!

    // The non-memo preview still bakes; the memo one is left unbaked, no throw.
    expect(previews.find((p) => p.id === "lp_stream")!.inAppData).toMatchObject({ kind: "stream", accessTier: "full" })
    expect(previews.find((p) => p.id === "lp_memo")!.inAppData).toBeUndefined()
  })
})

describe("LinkPreviewService.resolveInAppLinkByUrl", () => {
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS
  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.threa.io"
  })
  afterAll(() => {
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins
  })

  test("resolves full stream data straight from a stream URL, no preview row read", async () => {
    const findById = spyOn(LinkPreviewRepository, "findById")
    const service = makeService(
      { tryAccess: async () => makeStream({ slug: "design", description: "Where design happens" }) },
      {}
    )

    const result = await service.resolveInAppLinkByUrl(
      WORKSPACE_ID,
      VIEWER_ID,
      "https://app.threa.io/w/ws_self/s/stream_1"
    )

    expect(result).toEqual({
      kind: "stream",
      accessTier: "full",
      streamName: "design",
      streamType: "channel",
      visibility: "public",
      description: "Where design happens",
    })
    expect(findById).not.toHaveBeenCalled()
  })

  test("returns cross_workspace for a URL in another workspace without inspecting it", async () => {
    const tryAccess = spyOn({ tryAccess: async () => null }, "tryAccess")
    const service = makeService({ tryAccess: tryAccess as never }, {})

    const result = await service.resolveInAppLinkByUrl(
      WORKSPACE_ID,
      VIEWER_ID,
      "https://app.threa.io/w/ws_other/s/stream_1"
    )

    expect(result).toEqual({ kind: "stream", accessTier: "cross_workspace" })
    expect(tryAccess).not.toHaveBeenCalled()
  })

  test("resolves a message URL with ?m= to the message target", async () => {
    spyOn(MessageRepository, "findById").mockResolvedValue({
      id: "msg_1",
      streamId: "stream_1",
      authorType: "user",
      authorId: "user_author",
      contentMarkdown: "Hello there",
      deletedAt: null,
    } as never)
    spyOn(UserRepository, "findById").mockResolvedValue({ name: "Author", avatarUrl: null } as never)
    const service = makeService({ tryAccess: async () => makeStream({ slug: "general" }) }, {})

    const result = await service.resolveInAppLinkByUrl(
      WORKSPACE_ID,
      VIEWER_ID,
      "https://app.threa.io/w/ws_self/s/stream_1?m=msg_1"
    )

    expect(result).toMatchObject({
      kind: "message",
      accessTier: "full",
      authorName: "Author",
      streamName: "general",
    })
  })

  test("returns null for a URL that isn't a recognized in-app link", async () => {
    const service = makeService({}, {})
    expect(await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, "https://example.com/blog")).toBeNull()
    // A valid app origin but an unrecognized path is also null.
    expect(await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, "https://app.threa.io/settings")).toBeNull()
  })
})

describe("LinkPreviewService — delegation link resolution", () => {
  const previousOrigins = process.env.CORS_ALLOWED_ORIGINS
  beforeAll(() => {
    process.env.CORS_ALLOWED_ORIGINS = "https://app.threa.io"
  })
  afterAll(() => {
    if (previousOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS
    else process.env.CORS_ALLOWED_ORIGINS = previousOrigins
  })

  const SELF_URL = "https://app.threa.io/w/ws_self/delegations/dlg_1"
  const OTHER_URL = "https://app.threa.io/w/ws_other/delegations/dlg_1"

  function makeDelegationWithEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: "dlg_1",
      streamId: "stream_1",
      title: "Add rate limiting",
      status: "claimed",
      claimedByLabel: "Kris's MacBook / Claude Code",
      createdEventId: "event_1",
      ...overrides,
    } as never
  }

  test("returns cross_workspace for a delegation URL in another workspace without inspecting it", async () => {
    const getByIdWithEvent = spyOn({ getByIdWithEvent: async () => makeDelegationWithEvent() }, "getByIdWithEvent")
    const tryAccess = spyOn({ tryAccess: async () => null }, "tryAccess")
    const service = makeService({ tryAccess: tryAccess as never }, {}, { getByIdWithEvent: getByIdWithEvent as never })

    const result = await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, OTHER_URL)

    expect(result).toEqual({ kind: "delegation", accessTier: "cross_workspace" })
    expect(getByIdWithEvent).not.toHaveBeenCalled()
    expect(tryAccess).not.toHaveBeenCalled()
  })

  test("returns private when the delegation is missing", async () => {
    const service = makeService({ tryAccess: async () => makeStream() }, {}, { getByIdWithEvent: async () => null })

    expect(await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, SELF_URL)).toEqual({
      kind: "delegation",
      accessTier: "private",
    })
  })

  test("returns private when the viewer cannot access the delegation's stream", async () => {
    const service = makeService(
      { tryAccess: async () => null },
      {},
      { getByIdWithEvent: async () => makeDelegationWithEvent() }
    )

    expect(await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, SELF_URL)).toEqual({
      kind: "delegation",
      accessTier: "private",
    })
  })

  test("returns full delegation metadata when the viewer has access", async () => {
    const service = makeService(
      { tryAccess: async () => makeStream({ id: "stream_1", slug: "eng" }) },
      {},
      { getByIdWithEvent: async () => makeDelegationWithEvent({ status: "running" }) }
    )

    const result = await service.resolveInAppLinkByUrl(WORKSPACE_ID, VIEWER_ID, SELF_URL)

    expect(result).toEqual({
      kind: "delegation",
      accessTier: "full",
      delegationId: "dlg_1",
      title: "Add rate limiting",
      status: "running",
      claimedByLabel: "Kris's MacBook / Claude Code",
      streamId: "stream_1",
      streamType: "channel",
      createdEventId: "event_1",
    })
  })

  test("resolves full delegation metadata from a persisted preview row by id (bake/by-id path)", async () => {
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(
      makePreview({
        contentType: "delegation_link",
        targetStreamId: null,
        targetDelegationId: "dlg_1",
      })
    )
    const service = makeService(
      { tryAccess: async () => makeStream({ id: "stream_1", slug: "eng" }) },
      {},
      { getByIdWithEvent: async () => makeDelegationWithEvent({ status: "running" }) }
    )

    const result = await service.resolveInAppLink(WORKSPACE_ID, VIEWER_ID, "lp_1")

    expect(result).toEqual({
      kind: "delegation",
      accessTier: "full",
      delegationId: "dlg_1",
      title: "Add rate limiting",
      status: "running",
      claimedByLabel: "Kris's MacBook / Claude Code",
      streamId: "stream_1",
      streamType: "channel",
      createdEventId: "event_1",
    })
  })
})
