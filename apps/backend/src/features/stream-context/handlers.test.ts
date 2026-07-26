import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { createStreamContextHandlers } from "./handlers"
import type { StreamContextService } from "./service"

function harness(response: unknown = { items: [], counts: null, nextCursor: null, mode: "index" }) {
  const list = mock(async (_params: unknown) => response as never)
  const listOccurrences = mock(async (_params: unknown) => response as never)
  const handlers = createStreamContextHandlers({
    streamContextService: { list, listOccurrences } as unknown as StreamContextService,
  })
  const json = mock((_body: unknown) => undefined)
  return { handlers, list, listOccurrences, res: { json } as unknown as Response, json }
}

function request(query: Record<string, unknown>): Request {
  return {
    query,
    params: { streamId: "stream_1" },
    user: { id: "usr_1" },
    workspaceId: "ws_1",
  } as unknown as Request
}

describe("stream context handlers", () => {
  it("defaults scope to tree and limit to 40, and forwards the parsed filters", async () => {
    const { handlers, list, res, json } = harness()

    await handlers.list(
      request({ category: "media", q: "budget", from: "usr_7", before: "2026-07-01T00:00:00.000Z" }),
      res
    )

    expect(list.mock.calls[0]![0]).toEqual({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_1",
      scope: "tree",
      category: "media",
      queryText: "budget",
      authorId: "usr_7",
      before: new Date("2026-07-01T00:00:00.000Z"),
      after: undefined,
      cursor: undefined,
      limit: 40,
    })
    expect(json.mock.calls[0]![0]).toEqual({ items: [], counts: null, nextCursor: null, mode: "index" })
  })

  it("rejects an out-of-range limit, an unknown scope, and an unknown category", async () => {
    const { handlers, list, res } = harness()

    for (const query of [{ limit: "101" }, { scope: "workspace" }, { category: "invoice" }]) {
      await expect(handlers.list(request(query), res)).rejects.toMatchObject({
        status: 400,
        code: "VALIDATION_ERROR",
      })
    }
    expect(list).not.toHaveBeenCalled()
  })

  it("requires category and groupKey on the occurrences route", async () => {
    const { handlers, listOccurrences, res } = harness({ items: [], nextCursor: null })

    await expect(handlers.listOccurrences(request({ category: "link" }), res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    })
    expect(listOccurrences).not.toHaveBeenCalled()

    await handlers.listOccurrences(
      request({ category: "link", groupKey: "https://example.com/a", scope: "stream", limit: "5" }),
      res
    )

    expect(listOccurrences.mock.calls[0]![0]).toEqual({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_1",
      scope: "stream",
      category: "link",
      groupKey: "https://example.com/a",
      cursor: undefined,
      limit: 5,
    })
  })
})
