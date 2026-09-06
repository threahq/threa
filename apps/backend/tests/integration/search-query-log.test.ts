import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { HttpError } from "@threa/backend-common"
import { setupIsolatedTestDatabase } from "./setup"
import { SearchQueryLogRepository, SearchQueryLogService } from "../../src/features/search"
import { userId, workspaceId } from "../../src/lib/id"

describe("search query log", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let service: SearchQueryLogService
  const ws = workspaceId()
  const user = userId()

  beforeAll(async () => {
    ;({ pool, cleanup } = await setupIsolatedTestDatabase("search-query-log"))
    service = new SearchQueryLogService(pool)
  })

  afterAll(async () => {
    await cleanup()
  })

  const input = {
    workspaceId: ws,
    userId: user,
    query: "deploy checklist",
    params: { phrases: ["deploy checklist"], in: ["stream_1"], exact: false, limit: 20 },
    mode: "deep" as const,
    ranking: "improved" as const,
    resultIds: { messages: ["msg_1", "msg_2"], conversations: ["conv_1"] },
  }

  test("records the request and its results, then attributes the opened result", async () => {
    const { id } = await service.record(input)

    const [recorded] = await SearchQueryLogRepository.listForUser(pool, ws, user, 10)
    expect(recorded).toMatchObject({ id, ...input, clickedKind: null, clickedId: null, clickedAt: null })
    expect(recorded!.createdAt).toBeInstanceOf(Date)

    await service.recordClick({ workspaceId: ws, userId: user, id, kind: "message", targetId: "msg_2" })
    await service.recordClick({ workspaceId: ws, userId: user, id, kind: "conversation", targetId: "conv_1" })

    const [clicked] = await SearchQueryLogRepository.listForUser(pool, ws, user, 10)
    expect(clicked).toMatchObject({ id, clickedKind: "conversation", clickedId: "conv_1" })
    expect(clicked!.clickedAt).toBeInstanceOf(Date)
  })

  test("refuses a click on another user's entry", async () => {
    const { id } = await service.record(input)
    const other = userId()

    const err = await service
      .recordClick({ workspaceId: ws, userId: other, id, kind: "memo", targetId: "memo_1" })
      .then(
        () => null,
        (e: unknown) => e as HttpError
      )
    expect({ status: err?.status, code: err?.code }).toEqual({ status: 404, code: "SEARCH_QUERY_LOG_NOT_FOUND" })

    const [row] = await SearchQueryLogRepository.listForUser(pool, ws, user, 1)
    expect(row).toMatchObject({ id, clickedKind: null, clickedId: null })
  })
})
