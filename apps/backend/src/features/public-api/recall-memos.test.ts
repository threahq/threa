import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import type { PreparedRecall } from "../agents"

function createResponse(): { res: Response; getBody: () => unknown } {
  let body: unknown
  const res = { locals: {} } as Response
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  return { res, getBody: () => body }
}

function createHandlers(recall: PreparedRecall["recall"]) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    preparedRecall: { recall } as PublicApiDeps["preparedRecall"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {
      getAccessibleStreamIdsForBot: mock(() => Promise.resolve(["stream_public"])),
    } as unknown as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function botRequest(body: Record<string, unknown>): Request {
  return { workspaceId: "ws_1", body, botApiKey: { botId: "bot_1" } } as unknown as Request
}

describe("recallMemos", () => {
  it("recalls within the bot's readable streams with no user to unlock user-scoped memos", async () => {
    const recall = mock<PreparedRecall["recall"]>(() =>
      Promise.resolve({
        outcome: "recalled",
        memos: [
          {
            id: "memo_1",
            title: "Deploy order",
            abstract: "Regions before control plane.",
            knowledgeType: "procedure",
            sourceMessageIds: ["msg_1"],
            createdAt: new Date("2026-07-19T12:02:00.000Z"),
            score: 0.9,
          },
        ],
      })
    )
    const { res, getBody } = createResponse()

    await createHandlers(recall).recallMemos(botRequest({ query: "  how do we deploy?  " }), res)

    expect(recall.mock.calls[0]?.[0]).toEqual({
      workspaceId: "ws_1",
      invokingUserId: undefined,
      surface: "public_api",
      query: "how do we deploy?",
      accessibleStreamIds: new Set(["stream_public"]),
      memoViewerUserId: undefined,
      memoAudience: { kind: "streams", streamIds: ["stream_public"], browses: true },
      asker: undefined,
    })
    expect(getBody()).toEqual({
      data: [
        {
          id: "memo_1",
          title: "Deploy order",
          abstract: "Regions before control plane.",
          knowledgeType: "procedure",
          sourceMessageIds: ["msg_1"],
          createdAt: "2026-07-19T12:02:00.000Z",
          score: 0.9,
        },
      ],
      outcome: "recalled",
    })
  })

  it("passes a no-judgement outcome through so callers can fall back to search", async () => {
    const { res, getBody } = createResponse()

    await createHandlers(() => Promise.resolve({ outcome: "timeout", memos: [] })).recallMemos(
      botRequest({ query: "anything" }),
      res
    )

    expect(getBody()).toEqual({ data: [], outcome: "timeout" })
  })

  it("rejects a blank query before recalling", async () => {
    const recall = mock<PreparedRecall["recall"]>(() => Promise.resolve({ outcome: "recalled", memos: [] }))

    await expect(
      createHandlers(recall).recallMemos(botRequest({ query: "   " }), createResponse().res)
    ).rejects.toThrow()
    expect(recall).not.toHaveBeenCalled()
  })
})
