import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { LinkPreviewSummary } from "@threa/types"
import type { Request, Response } from "express"
import type { StreamEvent } from "./event-repository"
import { applyLinkPreviewStateToEvents, collectThreadAnchorIds, createStreamHandlers } from "./handlers"
import type { StreamService } from "./service"
import * as agentsBarrel from "../agents"

function createMessageEvent(messageId: string): StreamEvent {
  return {
    id: `evt_${messageId}`,
    streamId: "stream_1",
    sequence: 1n,
    broadcastSequence: 1n,
    eventType: "message_created",
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date(),
    payload: {
      messageId,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
    },
  }
}

describe("collectThreadAnchorIds", () => {
  it("collects canonical message and threadable card anchors", () => {
    const message = createMessageEvent("msg_1")
    const delegation = { ...message, id: "event_delegation", eventType: "delegation:created" as const, payload: {} }
    const membership = { ...message, id: "event_member", eventType: "member_joined" as const, payload: {} }

    expect(collectThreadAnchorIds([message, delegation, membership])).toEqual(["msg_1", "event_delegation"])
  })
})

describe("applyLinkPreviewStateToEvents", () => {
  it("attaches preview summaries to matching message events", () => {
    const preview: LinkPreviewSummary = {
      id: "preview_1",
      url: "https://example.com/article",
      title: "Preview title",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 0,
    }

    const [event] = applyLinkPreviewStateToEvents(
      [createMessageEvent("msg_1")],
      new Map([["msg_1", [preview]]]),
      new Set()
    )

    expect((event.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews).toEqual([preview])
  })

  it("filters dismissed previews out of the event payload", () => {
    const visiblePreview: LinkPreviewSummary = {
      id: "preview_visible",
      url: "https://example.com/visible",
      title: "Visible",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 0,
    }
    const dismissedPreview: LinkPreviewSummary = {
      id: "preview_dismissed",
      url: "https://example.com/dismissed",
      title: "Dismissed",
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: "Example",
      contentType: "website",
      position: 1,
    }

    const [event] = applyLinkPreviewStateToEvents(
      [createMessageEvent("msg_1")],
      new Map([["msg_1", [visiblePreview, dismissedPreview]]]),
      new Set(["msg_1:preview_dismissed"])
    )

    expect((event.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews).toEqual([visiblePreview])
  })

  it("applies the enriched preview when only the per-viewer inAppData differs", () => {
    // The stored event payload carries the same preview with no inAppData; the map
    // version adds it. The override must win or the card loses its synchronous data.
    const basePreview: LinkPreviewSummary = {
      id: "preview_msg",
      url: "https://app.threa.io/w/ws_1/s/stream_1?m=msg_target",
      title: null,
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: null,
      contentType: "message_link",
      position: 0,
    }
    const stored = createMessageEvent("msg_1")
    ;(stored.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews = [basePreview]
    const enriched: LinkPreviewSummary = {
      ...basePreview,
      inAppData: { kind: "message", accessTier: "full", authorName: "Author", contentPreview: "hi" },
    }

    const [event] = applyLinkPreviewStateToEvents([stored], new Map([["msg_1", [enriched]]]), new Set())

    expect((event.payload as { linkPreviews?: LinkPreviewSummary[] }).linkPreviews).toEqual([enriched])
  })
})

describe("createStreamHandlers.updateToolPolicy", () => {
  const scratchpad = { id: "stream_sp", workspaceId: "ws_1", type: "scratchpad", createdBy: "user_owner" }

  function makeRes() {
    const captured: { status: number; body: unknown } = { status: 200, body: undefined }
    const res = {
      status(code: number) {
        captured.status = code
        return res
      },
      json(body: unknown) {
        captured.body = body
        return res
      },
    }
    return { res: res as unknown as Response, captured }
  }

  function makeHandlers(streamService: Partial<StreamService>) {
    return createStreamHandlers({ streamService } as unknown as Parameters<typeof createStreamHandlers>[0])
  }

  function makeReq(body: unknown, callerId = "user_owner"): Request {
    return {
      user: { id: callerId },
      workspaceId: "ws_1",
      params: { streamId: "stream_sp" },
      body,
    } as unknown as Request
  }

  it("lets the scratchpad owner set the policy and echoes it back", async () => {
    const setStreamToolPolicy = mock(async (_ws: string, _s: string, policy: unknown) => policy)
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => scratchpad) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res, captured } = makeRes()

    await handlers.updateToolPolicy(makeReq({ allowedCategories: ["web"] }), res)

    expect(setStreamToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", ["web"], {
      kind: "user",
      userId: "user_owner",
    })
    expect(captured.body).toEqual({ data: { allowedToolCategories: ["web"] } })
  })

  it("clears the policy when allowedCategories is null", async () => {
    const setStreamToolPolicy = mock(async (_ws: string, _s: string, policy: unknown) => policy)
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => scratchpad) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res, captured } = makeRes()

    await handlers.updateToolPolicy(makeReq({ allowedCategories: null }), res)

    expect(setStreamToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", null, {
      kind: "user",
      userId: "user_owner",
    })
    expect(captured.body).toEqual({ data: { allowedToolCategories: null } })
  })

  it("rejects a non-owner with 403 and never writes", async () => {
    const setStreamToolPolicy = mock(async () => {
      throw Object.assign(new Error("forbidden"), { status: 403, code: "FORBIDDEN" })
    })
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => ({
        ...scratchpad,
        createdBy: "user_other",
      })) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res } = makeRes()

    await expect(handlers.updateToolPolicy(makeReq({ allowedCategories: ["web"] }), res)).rejects.toMatchObject({
      status: 403,
    })
    expect(setStreamToolPolicy).toHaveBeenCalled()
  })

  it("rejects a non-scratchpad stream with 400 and never writes", async () => {
    const setStreamToolPolicy = mock(async () => {
      throw Object.assign(new Error("invalid stream"), { status: 400, code: "INVALID_STREAM_TYPE" })
    })
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => ({
        ...scratchpad,
        type: "channel",
      })) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res } = makeRes()

    await expect(handlers.updateToolPolicy(makeReq({ allowedCategories: ["web"] }), res)).rejects.toMatchObject({
      status: 400,
    })
    expect(setStreamToolPolicy).toHaveBeenCalled()
  })
})

describe("createStreamHandlers.update — DM memoryMode", () => {
  const dm = { id: "stream_dm", workspaceId: "ws_1", type: "dm", createdBy: "user_a" }

  function makeRes() {
    const captured: { status: number; body: unknown } = { status: 200, body: undefined }
    const res = {
      status(code: number) {
        captured.status = code
        return res
      },
      json(body: unknown) {
        captured.body = body
        return res
      },
    }
    return { res: res as unknown as Response, captured }
  }

  function makeHandlers(streamService: Partial<StreamService>) {
    return createStreamHandlers({ streamService } as unknown as Parameters<typeof createStreamHandlers>[0])
  }

  function makeReq(body: unknown): Request {
    return {
      user: { id: "user_a" },
      workspaceId: "ws_1",
      params: { streamId: "stream_dm" },
      body,
    } as unknown as Request
  }

  it("lets a DM participant toggle memoryMode", async () => {
    const updateStream = mock(async (_id: string, data: { memoryMode?: string }) => ({ ...dm, ...data }))
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => dm) as unknown as StreamService["validateStreamAccess"],
      updateStream: updateStream as unknown as StreamService["updateStream"],
    })
    const { res, captured } = makeRes()

    await handlers.update(makeReq({ memoryMode: "off" }), res)

    expect(updateStream).toHaveBeenCalledWith("stream_dm", expect.objectContaining({ memoryMode: "off" }), {
      workspaceId: "ws_1",
      principal: { kind: "user", userId: "user_a" },
    })
    expect(captured.body).toEqual({ stream: expect.objectContaining({ memoryMode: "off" }) })
  })

  it("still rejects a DM visibility change and never writes", async () => {
    const updateStream = mock(async () => dm)
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => dm) as unknown as StreamService["validateStreamAccess"],
      updateStream: updateStream as unknown as StreamService["updateStream"],
    })
    const { res } = makeRes()

    await expect(handlers.update(makeReq({ visibility: "public" }), res)).rejects.toMatchObject({ status: 400 })
    expect(updateStream).not.toHaveBeenCalled()
  })
})

describe("createStreamHandlers.create — allowedToolCategories", () => {
  function makeRes() {
    const captured: { status: number; body: unknown } = { status: 200, body: undefined }
    const res = {
      status(code: number) {
        captured.status = code
        return res
      },
      json(body: unknown) {
        captured.body = body
        return res
      },
    }
    return { res: res as unknown as Response, captured }
  }

  function makeHandlers(streamService: Partial<StreamService>) {
    return createStreamHandlers({ streamService, pool: {} } as unknown as Parameters<typeof createStreamHandlers>[0])
  }

  function makeCreateReq(body: unknown): Request {
    return { user: { id: "user_owner" }, workspaceId: "ws_1", params: {}, body } as unknown as Request
  }

  let resolveSpy: ReturnType<typeof spyOn<typeof agentsBarrel, "resolveDefaultPersona">>
  let assertSpy: ReturnType<typeof spyOn<typeof agentsBarrel, "assertAssignablePersona">>

  beforeEach(() => {
    // A persona-less scratchpad create resolves the default and pins it. The
    // spies are shared across tests (bun returns the same instance) — clear them.
    resolveSpy = spyOn(agentsBarrel, "resolveDefaultPersona")
    resolveSpy.mockClear()
    resolveSpy.mockResolvedValue({ id: "persona_system_ariadne", status: "active" } as never)
    // An explicit client-supplied pin is validated against the caller before
    // create; default-allow so the non-personal-persona paths keep passing.
    assertSpy = spyOn(agentsBarrel, "assertAssignablePersona")
    assertSpy.mockClear()
    assertSpy.mockResolvedValue(undefined)
  })

  // The barrel spies replace live `../agents` bindings that sibling suites
  // (service.test.ts) call for real — restore them so the mock never leaks.
  afterEach(() => {
    resolveSpy.mockRestore()
    assertSpy.mockRestore()
  })

  it("threads allowedToolCategories to the service when creating a scratchpad", async () => {
    const create = mock(async (_params: { allowedToolCategories?: unknown }) => ({ id: "stream_sp" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res, captured } = makeRes()

    await handlers.create(makeCreateReq({ type: "scratchpad", allowedToolCategories: ["web"] }), res)

    expect(captured.status).toBe(201)
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0].allowedToolCategories).toEqual(["web"])
  })

  it("passes a message anchor through as parentAnchorId", async () => {
    const create = mock(async (_params: { parentAnchorId?: string }) => ({ id: "stream_thread" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res, captured } = makeRes()

    await handlers.create(
      makeCreateReq({ type: "thread", parentStreamId: "stream_channel", parentAnchorId: "msg_1" }),
      res
    )

    expect(captured.status).toBe(201)
    expect(create.mock.calls[0]![0].parentAnchorId).toBe("msg_1")
  })

  it("passes an event anchor through as parentAnchorId", async () => {
    const create = mock(async (_params: { parentAnchorId?: string }) => ({ id: "stream_thread" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res, captured } = makeRes()

    await handlers.create(
      makeCreateReq({ type: "thread", parentStreamId: "stream_channel", parentAnchorId: "event_1" }),
      res
    )

    expect(captured.status).toBe(201)
    expect(create.mock.calls[0]![0].parentAnchorId).toBe("event_1")
  })

  it("rejects a thread body with NEITHER anchor and never creates", async () => {
    const create = mock(async () => ({ id: "stream_thread" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await expect(
      handlers.create(makeCreateReq({ type: "thread", parentStreamId: "stream_channel" }), res)
    ).rejects.toMatchObject({ status: 400 })
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects allowedToolCategories on a non-scratchpad and never creates", async () => {
    const create = mock(async () => ({ id: "stream_ch" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await expect(
      handlers.create(makeCreateReq({ type: "channel", slug: "general", allowedToolCategories: ["web"] }), res)
    ).rejects.toMatchObject({ status: 400 })
    expect(create).not.toHaveBeenCalled()
  })

  it("pins the resolved default persona when a scratchpad is created with no explicit pick", async () => {
    const create = mock(async (_params: { companionPersonaId?: string }) => ({ id: "stream_sp" }))
    resolveSpy.mockResolvedValue({ id: "persona_pinned_default", status: "active" } as never)
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await handlers.create(makeCreateReq({ type: "scratchpad" }), res)

    // The default is resolved ONCE at create (creator's pref → workspace → Ariadne)
    // and the concrete id is pinned — later default changes never touch this stream.
    expect(resolveSpy).toHaveBeenCalledWith({}, "ws_1", "user_owner")
    expect(create.mock.calls[0]![0].companionPersonaId).toBe("persona_pinned_default")
  })

  it("keeps an explicit pick verbatim (no default resolution) after validating it against the caller", async () => {
    const create = mock(async (_params: { companionPersonaId?: string }) => ({ id: "stream_sp" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await handlers.create(makeCreateReq({ type: "scratchpad", companionPersonaId: "persona_explicit" }), res)

    expect(resolveSpy).not.toHaveBeenCalled()
    // The client-supplied pin is validated against the caller (own personal
    // persona allowed, another user's rejected) before it reaches the service.
    expect(assertSpy).toHaveBeenCalledWith({}, "persona_explicit", "ws_1", { callerUserId: "user_owner" })
    expect(create.mock.calls[0]![0].companionPersonaId).toBe("persona_explicit")
  })

  it("rejects an explicit pin the caller may not assign (foreign / another user's personal) and never creates", async () => {
    const create = mock(async () => ({ id: "stream_sp" }))
    assertSpy.mockRejectedValue(
      Object.assign(new Error("Persona not available"), { status: 400, code: "PERSONA_NOT_AVAILABLE" })
    )
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await expect(
      handlers.create(makeCreateReq({ type: "scratchpad", companionPersonaId: "persona_foreign" }), res)
    ).rejects.toMatchObject({ status: 400, code: "PERSONA_NOT_AVAILABLE" })
    expect(create).not.toHaveBeenCalled()
  })

  it("pins the caller's own explicit personal persona (assignment guard passes)", async () => {
    const create = mock(async (_params: { companionPersonaId?: string }) => ({ id: "stream_sp" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res, captured } = makeRes()

    await handlers.create(makeCreateReq({ type: "scratchpad", companionPersonaId: "persona_mine" }), res)

    expect(captured.status).toBe(201)
    expect(assertSpy).toHaveBeenCalledWith({}, "persona_mine", "ws_1", { callerUserId: "user_owner" })
    expect(create.mock.calls[0]![0].companionPersonaId).toBe("persona_mine")
  })

  it("does not resolve a default for non-scratchpad creates", async () => {
    const create = mock(async (_params: { companionPersonaId?: string }) => ({ id: "stream_ch" }))
    const handlers = makeHandlers({ create: create as unknown as StreamService["create"] })
    const { res } = makeRes()

    await handlers.create(makeCreateReq({ type: "channel", slug: "general" }), res)

    expect(resolveSpy).not.toHaveBeenCalled()
    expect(create.mock.calls[0]![0].companionPersonaId).toBeUndefined()
  })
})

describe("createStreamHandlers.markAsRead — access without membership", () => {
  function makeRes() {
    const captured: { status: number; body: unknown } = { status: 200, body: undefined }
    const res = {
      status(code: number) {
        captured.status = code
        return res
      },
      json(body: unknown) {
        captured.body = body
        return res
      },
    }
    return { res: res as unknown as Response, captured }
  }

  function makeHandlers(
    streamService: Partial<StreamService>,
    activityService: { markStreamActivityAsRead: (userId: string, streamId: string) => Promise<void> }
  ) {
    return createStreamHandlers({ streamService, activityService, pool: {} } as unknown as Parameters<
      typeof createStreamHandlers
    >[0])
  }

  function makeReq(): Request {
    return {
      user: { id: "usr_viewer" },
      workspaceId: "ws_1",
      params: { streamId: "stream_thread" },
      body: { lastEventId: "evt_1" },
    } as unknown as Request
  }

  it("clears stream activity and returns null membership for a non-member viewer", async () => {
    const validateStreamAccess = mock(() => Promise.resolve({ id: "stream_thread" } as never))
    const markAsRead = mock(() => Promise.resolve(null))
    const markStreamActivityAsRead = mock(() => Promise.resolve())
    const handlers = makeHandlers({ validateStreamAccess, markAsRead } as Partial<StreamService>, {
      markStreamActivityAsRead,
    })
    const { res, captured } = makeRes()

    await handlers.markAsRead(makeReq(), res)

    // Access (not membership) gates the read: a viewer who inherits thread
    // access from the root (INV-62) gets an activity-only read, not a 404.
    expect(captured.status).not.toBe(404)
    expect(captured.body).toEqual({ membership: null })
    expect(markStreamActivityAsRead).toHaveBeenCalledWith("usr_viewer", "ws_1", "stream_thread")
  })

  it("returns null membership for a non-member unread — the same-class 404 is gone", async () => {
    const validateStreamAccess = mock(() => Promise.resolve({ id: "stream_thread" } as never))
    const markUnread = mock(() => Promise.resolve(null))
    const handlers = makeHandlers({ validateStreamAccess, markUnread } as Partial<StreamService>, {
      markStreamActivityAsRead: mock(() => Promise.resolve()),
    })
    const { res, captured } = makeRes()

    await handlers.markUnread(
      {
        user: { id: "usr_viewer" },
        workspaceId: "ws_1",
        params: { streamId: "stream_thread" },
        body: { messageId: "msg_1" },
      } as unknown as Request,
      res
    )

    // Access (not membership) gates the unread (INV-62): null membership is a
    // successful standalone-frontier regress, not a 404.
    expect(captured.status).not.toBe(404)
    expect(captured.body).toEqual({ membership: null })
  })

  it("surfaces MESSAGE_NOT_FOUND from the service when the message isn't in the stream", async () => {
    const validateStreamAccess = mock(() => Promise.resolve({ id: "stream_thread" } as never))
    const markUnread = mock(() =>
      Promise.reject(Object.assign(new Error("Message not found"), { status: 404, code: "MESSAGE_NOT_FOUND" }))
    )
    const handlers = makeHandlers({ validateStreamAccess, markUnread } as Partial<StreamService>, {
      markStreamActivityAsRead: mock(() => Promise.resolve()),
    })
    const { res } = makeRes()

    await expect(
      handlers.markUnread(
        {
          user: { id: "usr_viewer" },
          workspaceId: "ws_1",
          params: { streamId: "stream_thread" },
          body: { messageId: "msg_gone" },
        } as unknown as Request,
        res
      )
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" })
  })

  it("returns the membership for a member read and still clears activity", async () => {
    const membership = {
      streamId: "stream_thread",
      memberId: "usr_viewer",
      notificationLevel: null,
      joinedAt: new Date(),
    }
    const validateStreamAccess = mock(() => Promise.resolve({ id: "stream_thread" } as never))
    const markAsRead = mock(() => Promise.resolve(membership))
    const markStreamActivityAsRead = mock(() => Promise.resolve())
    const handlers = makeHandlers({ validateStreamAccess, markAsRead } as Partial<StreamService>, {
      markStreamActivityAsRead,
    })
    const { res, captured } = makeRes()

    await handlers.markAsRead(makeReq(), res)

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ membership })
    expect(markStreamActivityAsRead).toHaveBeenCalledWith("usr_viewer", "ws_1", "stream_thread")
  })
})
