import { describe, expect, it, mock, afterEach } from "bun:test"
import type { Request, Response } from "express"
import { createSavedSuggestionsHandlers } from "./handlers"
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

describe("createSavedSuggestionsHandlers.list", () => {
  afterEach(() => mock.restore())

  it("defaults status to 'suggested'", async () => {
    let capturedStatus: string | undefined
    const list = mock(async (p: any) => {
      capturedStatus = p.status
      return { suggestions: [], nextCursor: null }
    })
    const handlers = createSavedSuggestionsHandlers({ savedSuggestionsService: { list } as any })
    await handlers.list(fakeReq({ query: {} }), fakeRes())
    expect(capturedStatus).toBe("suggested")
  })

  it("rejects an invalid status", async () => {
    const handlers = createSavedSuggestionsHandlers({ savedSuggestionsService: {} as any })
    await expect(handlers.list(fakeReq({ query: { status: "bogus" } as any }), fakeRes())).rejects.toBeInstanceOf(
      HttpError
    )
  })
})

describe("createSavedSuggestionsHandlers.accept / dismiss", () => {
  afterEach(() => mock.restore())

  it("routes accept to the service with the path id and returns suggestion+saved", async () => {
    const accept = mock(async () => ({ suggestion: { id: "sugg_1" }, saved: { id: "saved_1" } }) as any)
    const handlers = createSavedSuggestionsHandlers({ savedSuggestionsService: { accept } as any })
    const res = fakeRes()
    await handlers.accept(fakeReq({ params: { suggestionId: "sugg_1" } as any }), res)
    expect(accept).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "usr_1", suggestionId: "sugg_1" })
    expect(res.json).toHaveBeenCalledWith({ suggestion: { id: "sugg_1" }, saved: { id: "saved_1" } })
  })

  it("routes dismiss to the service and wraps the result", async () => {
    const dismiss = mock(async () => ({ id: "sugg_1", status: "dismissed" }) as any)
    const handlers = createSavedSuggestionsHandlers({ savedSuggestionsService: { dismiss } as any })
    const res = fakeRes()
    await handlers.dismiss(fakeReq({ params: { suggestionId: "sugg_1" } as any }), res)
    expect(dismiss).toHaveBeenCalledWith({ workspaceId: "ws_1", userId: "usr_1", suggestionId: "sugg_1" })
    expect(res.json).toHaveBeenCalledWith({ suggestion: { id: "sugg_1", status: "dismissed" } })
  })
})
