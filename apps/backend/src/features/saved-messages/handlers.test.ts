import { describe, expect, it, mock, spyOn, afterEach } from "bun:test"
import type { Request, Response } from "express"
import { SavedStatuses } from "@threa/types"
import { createSavedMessagesHandlers } from "./handlers"
import { HttpError } from "../../lib/errors"

function fakeRes() {
  const res: Partial<Response> = {}
  res.json = mock((..._args: unknown[]) => res as Response)
  return res as Response
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request
}

describe("createSavedMessagesHandlers.update", () => {
  afterEach(() => mock.restore())

  it("rejects PATCH containing both status and remindAt with 400", async () => {
    const updateReminder = mock(async () => ({}) as any)
    const updateStatus = mock(async () => ({}) as any)
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateReminder, updateStatus } as any,
    })

    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { status: SavedStatuses.DONE, remindAt: "2026-04-16T13:00:00.000Z" },
    })

    await expect(handlers.update(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
    expect(updateReminder).not.toHaveBeenCalled()
    expect(updateStatus).not.toHaveBeenCalled()
  })

  it("accepts status-only PATCH", async () => {
    const updateStatus = mock(async () => ({ id: "saved_01", status: SavedStatuses.DONE }) as any)
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateStatus } as any,
    })
    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { status: SavedStatuses.DONE },
    })
    const res = fakeRes()

    await handlers.update(req, res)
    expect(updateStatus).toHaveBeenCalledTimes(1)
  })

  it("accepts remindAt-only PATCH and parses it to a Date", async () => {
    let received: Date | null | undefined
    const updateReminder = mock(async (p: any) => {
      received = p.remindAt
      return { id: "saved_01" } as any
    })
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateReminder } as any,
    })
    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { remindAt: "2026-04-16T13:00:00.000Z" },
    })

    await handlers.update(req, fakeRes())

    expect(updateReminder).toHaveBeenCalledTimes(1)
    expect(received).toBeInstanceOf(Date)
    expect((received as Date).toISOString()).toBe("2026-04-16T13:00:00.000Z")
  })

  it("accepts remindAt: null to clear a reminder", async () => {
    let received: Date | null | undefined = undefined
    const updateReminder = mock(async (p: any) => {
      received = p.remindAt
      return { id: "saved_01" } as any
    })
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateReminder } as any,
    })
    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { remindAt: null },
    })

    await handlers.update(req, fakeRes())
    expect(received).toBeNull()
  })

  it("rejects empty PATCH body with 400", async () => {
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: {} as any,
    })
    const req = fakeReq({ params: { savedId: "saved_01" } as any, body: {} })

    await expect(handlers.update(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("routes title/note PATCH to updateContent as one content group", async () => {
    let received: { title?: string; note?: string | null } | undefined
    const updateContent = mock(async (p: any) => {
      received = { title: p.title, note: p.note }
      return { id: "saved_01" } as any
    })
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateContent } as any,
    })
    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { title: "Renamed", note: "more context" },
    })

    await handlers.update(req, fakeRes())

    expect(updateContent).toHaveBeenCalledTimes(1)
    expect(received).toEqual({ title: "Renamed", note: "more context" })
  })

  it("accepts note: null to clear the note", async () => {
    let received: string | null | undefined = undefined
    const updateContent = mock(async (p: any) => {
      received = p.note
      return { id: "saved_01" } as any
    })
    const handlers = createSavedMessagesHandlers({
      savedMessagesService: { updateContent } as any,
    })
    const req = fakeReq({ params: { savedId: "saved_01" } as any, body: { note: null } })

    await handlers.update(req, fakeRes())
    expect(received).toBeNull()
  })

  it("rejects PATCH mixing content with status with 400", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({
      params: { savedId: "saved_01" } as any,
      body: { status: SavedStatuses.DONE, note: "x" },
    })
    await expect(handlers.update(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects empty-string title with 400 (titles cannot be cleared)", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({ params: { savedId: "saved_01" } as any, body: { title: "  " } })
    await expect(handlers.update(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })
})

describe("createSavedMessagesHandlers.list", () => {
  afterEach(() => mock.restore())

  it("defaults status to 'saved' when no query param", async () => {
    let capturedStatus: string | undefined
    const list = mock(async (p: any) => {
      capturedStatus = p.status
      return { saved: [], nextCursor: null }
    })
    const handlers = createSavedMessagesHandlers({ savedMessagesService: { list } as any })
    const req = fakeReq({ query: {} })
    await handlers.list(req, fakeRes())
    expect(capturedStatus).toBe("saved")
  })

  it("rejects invalid status", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({ query: { status: "pending" } as any })
    await expect(handlers.list(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })
})

describe("createSavedMessagesHandlers.create", () => {
  afterEach(() => mock.restore())

  it("rejects a body with neither messageId nor title", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({ body: {} })
    await expect(handlers.create(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects a body with both messageId and title", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({ body: { messageId: "msg_1", title: "Standalone" } })
    await expect(handlers.create(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("rejects note alongside messageId (notes are added via PATCH)", async () => {
    const handlers = createSavedMessagesHandlers({ savedMessagesService: {} as any })
    const req = fakeReq({ body: { messageId: "msg_1", note: "context" } })
    await expect(handlers.create(req, fakeRes())).rejects.toBeInstanceOf(HttpError)
  })

  it("passes null remindAt when absent", async () => {
    let capturedRemindAt: Date | null | undefined
    const save = mock(async (p: any) => {
      capturedRemindAt = p.remindAt
      return { id: "saved_01" } as any
    })
    const handlers = createSavedMessagesHandlers({ savedMessagesService: { save } as any })
    const req = fakeReq({ body: { messageId: "msg_1" } })
    await handlers.create(req, fakeRes())
    expect(capturedRemindAt).toBeNull()
  })

  it("routes title-only bodies to createStandalone with trimmed title and null note", async () => {
    let received: { title: string; note: string | null } | undefined
    const createStandalone = mock(async (p: any) => {
      received = { title: p.title, note: p.note }
      return { id: "saved_01" } as any
    })
    const save = mock(async () => ({}) as any)
    const handlers = createSavedMessagesHandlers({ savedMessagesService: { createStandalone, save } as any })
    const req = fakeReq({ body: { title: "  Call the landlord  " } })

    await handlers.create(req, fakeRes())

    expect(save).not.toHaveBeenCalled()
    expect(createStandalone).toHaveBeenCalledTimes(1)
    expect(received).toEqual({ title: "Call the landlord", note: null })
  })
})
