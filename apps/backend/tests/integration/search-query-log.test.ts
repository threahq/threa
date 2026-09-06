import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
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
    resultIds: { messages: ["msg_1", "msg_2"], conversations: ["conv_1"], memos: ["memo_1"] },
  }

  test("records the request and its results, then attributes the opened result", async () => {
    const { id } = await service.record(input)

    const [recorded] = await SearchQueryLogRepository.listForUser(pool, ws, user, 10)
    expect(recorded).toMatchObject({ id, ...input, clickedKind: null, clickedId: null, clickedAt: null })
    expect(recorded!.createdAt).toBeInstanceOf(Date)

    await service.recordClick({ workspaceId: ws, userId: user, id, kind: "message", targetId: "msg_2" })
    await service.recordClick({ workspaceId: ws, userId: user, id, kind: "conversation", targetId: "conv_1" })
    await service.recordClick({ workspaceId: ws, userId: user, id, kind: "memo", targetId: "memo_1" })

    const [clicked] = await SearchQueryLogRepository.listForUser(pool, ws, user, 10)
    expect(clicked).toMatchObject({ id, clickedKind: "memo", clickedId: "memo_1" })
    expect(clicked!.clickedAt).toBeInstanceOf(Date)
  })

  const refused = (params: Parameters<SearchQueryLogService["recordClick"]>[0]) =>
    service.recordClick(params).then(
      () => null,
      (e: unknown) => ({ status: (e as HttpError).status, code: (e as HttpError).code })
    )

  test("refuses a click on another user's entry", async () => {
    const { id } = await service.record(input)
    const other = userId()

    const err = await refused({ workspaceId: ws, userId: other, id, kind: "message", targetId: "msg_1" })
    expect(err).toEqual({ status: 404, code: "SEARCH_QUERY_LOG_NOT_FOUND" })

    const [row] = await SearchQueryLogRepository.listForUser(pool, ws, user, 1)
    expect(row).toMatchObject({ id, clickedKind: null, clickedId: null })
  })

  test("refuses a target the search did not return, including a returned id under the wrong kind", async () => {
    const { id } = await service.record(input)

    const absent = await refused({ workspaceId: ws, userId: user, id, kind: "message", targetId: "msg_999" })
    const wrongKind = await refused({ workspaceId: ws, userId: user, id, kind: "conversation", targetId: "msg_1" })
    expect({ absent, wrongKind }).toEqual({
      absent: { status: 404, code: "SEARCH_QUERY_LOG_NOT_FOUND" },
      wrongKind: { status: 404, code: "SEARCH_QUERY_LOG_NOT_FOUND" },
    })

    const [row] = await SearchQueryLogRepository.listForUser(pool, ws, user, 1)
    expect(row).toMatchObject({ id, clickedKind: null, clickedId: null })
  })
})
