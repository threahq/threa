import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { ContextIntents, ContextRefKinds } from "@threahq/types"
import { createContextBagHandlers } from "./handlers"
import * as precomputeService from "./precompute-service"
import * as dbModule from "../../../db"
import { StreamRepository, StreamMemberRepository } from "../../streams"
import { MessageRepository } from "../../messaging"
import { ContextBagRepository } from "./repository"
import { ThreadResolver } from "./resolvers/thread-resolver"

function mockReq(body: unknown, params: Record<string, string> = {}) {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    body,
    params,
  } as never
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
  }
  return res as never
}

describe("createContextBagHandlers.precompute", () => {
  afterEach(() => {
    mock.restore()
  })

  it("delegates a valid payload to precomputeRefSummaries and returns the results", async () => {
    const precomputeSpy = spyOn(precomputeService, "precomputeRefSummaries").mockResolvedValue([
      {
        kind: ContextRefKinds.THREAD,
        refKey: "thread:stream_src",
        fingerprint: "fp_1",
        tailMessageId: "msg_9",
        status: "ready",
        itemCount: 10,
        inlineChars: 10000,
      },
    ])

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq({
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [{ kind: ContextRefKinds.THREAD, streamId: "stream_src" }],
    })
    const res = mockRes() as any
    await handlers.precompute(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      refs: [
        {
          kind: ContextRefKinds.THREAD,
          refKey: "thread:stream_src",
          fingerprint: "fp_1",
          tailMessageId: "msg_9",
          status: "ready",
          itemCount: 10,
          inlineChars: 10000,
        },
      ],
    })
    expect(precomputeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: "ws_1",
        userId: "usr_1",
        intent: ContextIntents.DISCUSS_THREAD,
      })
    )
  })

  it("throws a 400 VALIDATION_ERROR when the body is missing required fields", async () => {
    const precomputeSpy = spyOn(precomputeService, "precomputeRefSummaries")

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq({ intent: ContextIntents.DISCUSS_THREAD })
    const res = mockRes() as any

    await expect(handlers.precompute(req, res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Validation failed",
    })
    expect(precomputeSpy).not.toHaveBeenCalled()
  })

  it("throws a 400 VALIDATION_ERROR when refs is empty", async () => {
    const precomputeSpy = spyOn(precomputeService, "precomputeRefSummaries")

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq({ intent: ContextIntents.DISCUSS_THREAD, refs: [] })
    const res = mockRes() as any

    await expect(handlers.precompute(req, res)).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(precomputeSpy).not.toHaveBeenCalled()
  })

  it("throws a 400 VALIDATION_ERROR when a ref has an unknown kind", async () => {
    const precomputeSpy = spyOn(precomputeService, "precomputeRefSummaries")

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq({
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [{ kind: "memo", memoId: "memo_1" }],
    })
    const res = mockRes() as any

    await expect(handlers.precompute(req, res)).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
    expect(precomputeSpy).not.toHaveBeenCalled()
  })
})

describe("createContextBagHandlers.getStreamBag", () => {
  afterEach(() => {
    mock.restore()
  })

  function stubWithClient() {
    spyOn(dbModule, "withClient").mockImplementation(async (pool: any, fn: any) => fn(pool))
  }

  function stubAccessOk() {
    spyOn(StreamRepository, "findById").mockImplementation(
      async (_db, id: string) =>
        ({
          id,
          workspaceId: "ws_1",
          type: id === "stream_scratch" ? "scratchpad" : "channel",
          slug: id === "stream_src" ? "intro" : null,
          displayName: id === "stream_src" ? "Intro" : null,
        }) as any
    )
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(true)
  }

  it("returns the bag with enriched per-ref source metadata", async () => {
    stubWithClient()
    stubAccessOk()
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      {
        id: "stream_src",
        workspaceId: "ws_1",
        type: "channel",
        slug: "intro",
        displayName: "Intro",
      } as any,
    ])
    spyOn(ContextBagRepository, "findByStream").mockResolvedValue({
      id: "sca_1",
      workspaceId: "ws_1",
      streamId: "stream_scratch",
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [{ kind: ContextRefKinds.THREAD, streamId: "stream_src" }],
      lastRendered: null,
      createdBy: "usr_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    spyOn(ThreadResolver, "assertAccess").mockResolvedValue(undefined)
    spyOn(MessageRepository, "countByStreams").mockResolvedValue(new Map([["stream_src", 12]]))

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq(undefined, { streamId: "stream_scratch" })
    const res = mockRes() as any
    await handlers.getStreamBag(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({
      bag: { id: "sca_1", intent: ContextIntents.DISCUSS_THREAD },
      refs: [
        {
          kind: ContextRefKinds.THREAD,
          streamId: "stream_src",
          conversationId: null,
          fromMessageId: null,
          toMessageId: null,
          originMessageId: null,
          source: {
            streamId: "stream_src",
            displayName: "Intro",
            slug: "intro",
            type: "channel",
            itemCount: 12,
          },
        },
      ],
    })
  })

  it("clamps itemCount to the discuss-window size for DISCUSS_THREAD bags", async () => {
    // Regression: the resolver only sends ~50 messages to the AI for the
    // discuss-thread intent, but the chip used to show the raw stream total
    // (e.g. "487 messages in #intro") which lied about what the model
    // actually sees. Pin the clamp here so the chip matches reality.
    stubWithClient()
    stubAccessOk()
    spyOn(StreamRepository, "findByIds").mockResolvedValue([
      {
        id: "stream_src",
        workspaceId: "ws_1",
        type: "channel",
        slug: "intro",
        displayName: "Intro",
      } as any,
    ])
    spyOn(ContextBagRepository, "findByStream").mockResolvedValue({
      id: "sca_1",
      workspaceId: "ws_1",
      streamId: "stream_scratch",
      intent: ContextIntents.DISCUSS_THREAD,
      refs: [{ kind: ContextRefKinds.THREAD, streamId: "stream_src" }],
      lastRendered: null,
      createdBy: "usr_1",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    spyOn(ThreadResolver, "assertAccess").mockResolvedValue(undefined)
    spyOn(MessageRepository, "countByStreams").mockResolvedValue(new Map([["stream_src", 487]]))

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq(undefined, { streamId: "stream_scratch" })
    const res = mockRes() as any
    await handlers.getStreamBag(req, res)

    expect(res.statusCode).toBe(200)
    expect((res.body as any).refs[0].source.itemCount).toBe(50)
  })

  it("returns an empty bag when the stream has no attachment", async () => {
    stubWithClient()
    stubAccessOk()
    spyOn(ContextBagRepository, "findByStream").mockResolvedValue(null)

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq(undefined, { streamId: "stream_scratch" })
    const res = mockRes() as any
    await handlers.getStreamBag(req, res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ bag: null, refs: [] })
  })

  it("403s when the stream does not exist or belongs to another workspace", async () => {
    // checkStreamAccess collapses missing / wrong-workspace / no-access into a
    // single FORBIDDEN response so the error doesn't confirm existence of
    // streams the caller can't see.
    stubWithClient()
    spyOn(StreamRepository, "findById").mockResolvedValue(null)

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq(undefined, { streamId: "stream_missing" })
    const res = mockRes() as any
    await expect(handlers.getStreamBag(req, res)).rejects.toThrow("No access to stream")
  })

  it("403s when the user is not a member of the stream", async () => {
    stubWithClient()
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "stream_scratch",
      workspaceId: "ws_1",
      type: "scratchpad",
    } as any)
    spyOn(StreamMemberRepository, "isMember").mockResolvedValue(false)

    const handlers = createContextBagHandlers({ pool: {} as any, ai: {} as any })
    const req = mockReq(undefined, { streamId: "stream_scratch" })
    const res = mockRes() as any
    await expect(handlers.getStreamBag(req, res)).rejects.toThrow("No access to stream")
  })
})
