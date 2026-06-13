import { describe, expect, it, mock } from "bun:test"
import type { LinkPreviewSummary } from "@threa/types"
import type { Request, Response } from "express"
import type { StreamEvent } from "./event-repository"
import { applyLinkPreviewStateToEvents, createStreamHandlers } from "./handlers"
import type { StreamService } from "./service"

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

    expect(setStreamToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", ["web"])
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

    expect(setStreamToolPolicy).toHaveBeenCalledWith("ws_1", "stream_sp", null)
    expect(captured.body).toEqual({ data: { allowedToolCategories: null } })
  })

  it("rejects a non-owner with 403 and never writes", async () => {
    const setStreamToolPolicy = mock(async () => null)
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => ({
        ...scratchpad,
        createdBy: "user_other",
      })) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res, captured } = makeRes()

    await handlers.updateToolPolicy(makeReq({ allowedCategories: ["web"] }), res)

    expect(captured.status).toBe(403)
    expect(setStreamToolPolicy).not.toHaveBeenCalled()
  })

  it("rejects a non-scratchpad stream with 400 and never writes", async () => {
    const setStreamToolPolicy = mock(async () => null)
    const handlers = makeHandlers({
      validateStreamAccess: mock(async () => ({
        ...scratchpad,
        type: "channel",
      })) as unknown as StreamService["validateStreamAccess"],
      setStreamToolPolicy: setStreamToolPolicy as unknown as StreamService["setStreamToolPolicy"],
    })
    const { res, captured } = makeRes()

    await handlers.updateToolPolicy(makeReq({ allowedCategories: ["web"] }), res)

    expect(captured.status).toBe(400)
    expect(setStreamToolPolicy).not.toHaveBeenCalled()
  })
})
