import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, renderHook } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { toast } from "sonner"
import { StreamTypes } from "@threahq/types"
import { spyOnExport } from "@/test"
import { ApiError } from "@/api/client"
import * as contextsModule from "@/contexts"
import * as docCanWrite from "@/components/docs/use-doc-can-write"
import * as canManageChannelsModule from "@/lib/use-can-manage-channels"
import * as streamsModule from "./use-streams"
import { useCreateDoc, useCreateTopLevelDoc } from "./use-create-doc"

const channel = {
  id: "stream_host",
  type: StreamTypes.CHANNEL,
  e2eEnabled: false,
  archivedAt: null,
}

let mutateAsync: ReturnType<typeof vi.fn>
let isPending: boolean
let openPanel: ReturnType<typeof vi.fn>
let rootWriteAccess: boolean | null

beforeEach(() => {
  vi.restoreAllMocks()
  isPending = false
  rootWriteAccess = true
  mutateAsync = vi.fn(async () => ({ id: "stream_doc" }))
  openPanel = vi.fn()
  // `spyOnExport` replaces the module getter, so the value IS the hook.
  spyOnExport(streamsModule, "useCreateStream").mockReturnValue((() => ({ mutateAsync, isPending })) as never)
  spyOnExport(contextsModule, "usePanel").mockReturnValue((() => ({ openPanel })) as never)
  spyOnExport(docCanWrite, "useRootWriteAccess").mockReturnValue((() => rootWriteAccess) as never)
})

describe("useCreateDoc", () => {
  it.each([
    ["a member's channel", true, channel, true],
    ["a member's scratchpad", true, { ...channel, type: StreamTypes.SCRATCHPAD }, true],
    ["a member's DM", true, { ...channel, type: StreamTypes.DM }, true],
    ["a non-member's channel", false, channel, false],
    ["a guest-closed DM", false, { ...channel, type: StreamTypes.DM }, false],
    ["a host whose write access is unresolved", false, channel, null],
    ["no host", false, undefined, true],
    ["a thread", false, { ...channel, type: StreamTypes.THREAD }, true],
    ["a doc", false, { ...channel, type: StreamTypes.DOC }, true],
    ["an encrypted host", false, { ...channel, e2eEnabled: true }, true],
    ["an archived host", false, { ...channel, archivedAt: "2026-10-01T00:00:00.000Z" }, true],
  ])("on %s, enabled is %s", (_label, enabled, host, writeAccess) => {
    rootWriteAccess = writeAccess
    const { result } = renderHook(() => useCreateDoc("ws_1", host))
    expect(result.current.enabled).toBe(enabled)
  })

  it("creates the doc with exactly its type and host, then opens it beside the host", async () => {
    const { result } = renderHook(() => useCreateDoc("ws_1", channel))
    await act(() => result.current.run())

    expect(mutateAsync.mock.calls).toEqual([[{ type: "doc", parentStreamId: "stream_host" }]])
    expect(openPanel.mock.calls).toEqual([["stream_doc", { beside: "stream_host" }]])
  })

  it("should create the doc with the trimmed title and resolve to it when a title is given", async () => {
    const { result } = renderHook(() => useCreateDoc("ws_1", channel))
    let doc: unknown
    await act(async () => {
      doc = await result.current.run("  Q4 findings  ")
    })

    expect({ doc, calls: mutateAsync.mock.calls }).toEqual({
      doc: { id: "stream_doc" },
      calls: [[{ type: "doc", parentStreamId: "stream_host", displayName: "Q4 findings" }]],
    })
  })

  it("creates nothing while an earlier create is still in flight", async () => {
    isPending = true
    const { result } = renderHook(() => useCreateDoc("ws_1", channel))
    await act(() => result.current.run())

    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it.each([
    ["DOC_HOST_TYPE_INVALID", "Docs can't be created in this stream."],
    ["DOC_E2E_HOST_NOT_ALLOWED", "Docs can't be created in an encrypted stream."],
    ["STREAM_READ_ONLY", "You can't create docs here."],
    ["INTERNAL_ERROR", "Couldn't create the doc. Please try again."],
  ])("toasts the failure for %s and opens nothing", async (code, message) => {
    const toastError = vi.spyOn(toast, "error")
    mutateAsync.mockRejectedValueOnce(new ApiError(400, code, "nope"))
    const { result } = renderHook(() => useCreateDoc("ws_1", channel))
    await act(() => result.current.run())

    expect(toastError.mock.calls).toEqual([[message]])
    expect(openPanel).not.toHaveBeenCalled()
  })
})

describe("useCreateTopLevelDoc", () => {
  let canManageChannels: boolean

  beforeEach(() => {
    canManageChannels = true
    spyOnExport(canManageChannelsModule, "useCanManageChannels").mockReturnValue((() => canManageChannels) as never)
  })

  function renderTopLevel() {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        { initialEntries: ["/w/ws_1"] },
        createElement(Routes, null, createElement(Route, { path: "*", element: children }))
      )
    return renderHook(() => ({ create: useCreateTopLevelDoc("ws_1"), path: useLocation().pathname }), { wrapper })
  }

  it("should create a doc with no host and go to it", async () => {
    const { result } = renderTopLevel()
    await act(() => result.current.create.run())

    expect({ calls: mutateAsync.mock.calls, path: result.current.path }).toEqual({
      calls: [[{ type: "doc" }]],
      path: "/w/ws_1/s/stream_doc",
    })
  })

  it("should be disabled for a viewer who can't manage channels", () => {
    canManageChannels = false
    expect(renderTopLevel().result.current.create.enabled).toBe(false)
  })

  it("should toast a failed create and stay put", async () => {
    const toastError = vi.spyOn(toast, "error")
    mutateAsync.mockRejectedValueOnce(new ApiError(500, "INTERNAL_ERROR", "nope"))
    const { result } = renderTopLevel()
    await act(() => result.current.create.run())

    expect({ toasts: toastError.mock.calls, path: result.current.path }).toEqual({
      toasts: [["Couldn't create the doc. Please try again."]],
      path: "/w/ws_1",
    })
  })
})
