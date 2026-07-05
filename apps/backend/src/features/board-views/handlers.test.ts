import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createBoardViewHandlers } from "./handlers"

function mockReq(overrides: Record<string, unknown> = {}) {
  return { user: { id: "usr_1" }, workspaceId: "ws_1", params: {}, query: {}, body: {}, ...overrides } as never
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

describe("Board view handlers", () => {
  const mockList = mock(() => Promise.resolve([] as unknown[]))
  const mockCreate = mock(() => Promise.resolve({ id: "boardview_1" } as Record<string, unknown>))
  const mockUpdate = mock(() => Promise.resolve({ id: "boardview_1" } as Record<string, unknown>))
  const mockDelete = mock(() => Promise.resolve())
  const mockGetFlag = mock(() => Promise.resolve("on" as string))

  const handlers = createBoardViewHandlers({
    boardViewService: { list: mockList, create: mockCreate, update: mockUpdate, delete: mockDelete } as never,
    featureFlagService: { getFlag: mockGetFlag } as never,
  })

  beforeEach(() => {
    mockList.mockReset()
    mockCreate.mockReset()
    mockUpdate.mockReset()
    mockDelete.mockReset()
    mockGetFlag.mockReset()
    mockList.mockResolvedValue([])
    mockCreate.mockResolvedValue({ id: "boardview_1", name: "My view" })
    mockUpdate.mockResolvedValue({ id: "boardview_1", name: "Renamed" })
    mockGetFlag.mockResolvedValue("on")
  })

  test("list returns the viewer's saved views", async () => {
    mockList.mockResolvedValue([{ id: "boardview_1" }])
    const res = mockRes()
    await handlers.list(mockReq(), res)
    expect(mockList).toHaveBeenCalledWith("ws_1", "usr_1")
    expect((res as unknown as { body: unknown }).body).toEqual({ boardViews: [{ id: "boardview_1" }] })
  })

  test("create validates the body and delegates with owner ids, 201", async () => {
    const res = mockRes()
    await handlers.create(
      mockReq({ body: { name: "Design work", baseLens: "mine", scopeStreamIds: ["stream_1"] } }),
      res
    )
    expect(mockCreate).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "usr_1",
      name: "Design work",
      baseLens: "mine",
      scopeStreamIds: ["stream_1"],
      scopeStreamTypes: [],
    })
    expect((res as unknown as { statusCode: number }).statusCode).toBe(201)
  })

  test("create rejects an empty name with a 400", async () => {
    await expect(handlers.create(mockReq({ body: { name: "", baseLens: "all" } }), mockRes())).rejects.toMatchObject({
      status: 400,
    })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  test("create rejects an unknown lens with a 400", async () => {
    await expect(handlers.create(mockReq({ body: { name: "x", baseLens: "bogus" } }), mockRes())).rejects.toMatchObject(
      { status: 400 }
    )
  })

  test("update renames a view", async () => {
    const res = mockRes()
    await handlers.update(mockReq({ params: { boardViewId: "boardview_1" }, body: { name: "Renamed" } }), res)
    expect(mockUpdate).toHaveBeenCalledWith("ws_1", "usr_1", "boardview_1", { name: "Renamed" })
  })

  test("update rejects an empty body with a 400", async () => {
    await expect(
      handlers.update(mockReq({ params: { boardViewId: "boardview_1" }, body: {} }), mockRes())
    ).rejects.toMatchObject({ status: 400 })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  test("remove deletes a view", async () => {
    const res = mockRes()
    await handlers.remove(mockReq({ params: { boardViewId: "boardview_1" } }), res)
    expect(mockDelete).toHaveBeenCalledWith("ws_1", "usr_1", "boardview_1")
    expect((res as unknown as { body: unknown }).body).toEqual({ ok: true })
  })

  test("every endpoint 404s without the board-view flag before touching the service", async () => {
    mockGetFlag.mockResolvedValue("off")
    await expect(handlers.list(mockReq(), mockRes())).rejects.toMatchObject({ status: 404 })
    await expect(handlers.create(mockReq({ body: { name: "x", baseLens: "all" } }), mockRes())).rejects.toMatchObject({
      status: 404,
    })
    expect(mockList).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
