import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { toast } from "sonner"
import { StreamTypes } from "@threahq/types"
import { spyOnExport } from "@/test"
import { ApiError } from "@/api/client"
import * as contextsModule from "@/contexts"
import * as streamStoreModule from "@/stores/stream-store"
import * as streamsModule from "./use-streams"
import { useCreateDoc } from "./use-create-doc"

const channel = {
  id: "stream_host",
  type: StreamTypes.CHANNEL,
  e2eEnabled: false,
  archivedAt: null,
  rootStreamId: null,
}

let mutateAsync: ReturnType<typeof vi.fn>
let openPanel: ReturnType<typeof vi.fn>
let root: { archivedAt: string | null } | undefined

beforeEach(() => {
  vi.restoreAllMocks()
  root = undefined
  mutateAsync = vi.fn(async () => ({ id: "stream_doc" }))
  openPanel = vi.fn()
  // `spyOnExport` replaces the module getter, so the value IS the hook.
  spyOnExport(streamsModule, "useCreateStream").mockReturnValue((() => ({ mutateAsync })) as never)
  spyOnExport(contextsModule, "usePanel").mockReturnValue((() => ({ openPanel })) as never)
  spyOnExport(streamStoreModule, "useStreamFromStore").mockReturnValue((() => root) as never)
})

describe("useCreateDoc", () => {
  it("is enabled on a writable channel, scratchpad, or DM", () => {
    for (const type of [StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD, StreamTypes.DM]) {
      const { result } = renderHook(() => useCreateDoc("ws_1", { ...channel, type }))
      expect(result.current.enabled).toBe(true)
    }
  })

  it("is disabled where the host cannot hold a doc", () => {
    const hosts = [
      undefined,
      { ...channel, type: StreamTypes.THREAD },
      { ...channel, type: StreamTypes.DOC },
      { ...channel, e2eEnabled: true },
      { ...channel, archivedAt: "2026-10-01T00:00:00.000Z" },
    ]
    for (const host of hosts) {
      const { result } = renderHook(() => useCreateDoc("ws_1", host))
      expect(result.current.enabled).toBe(false)
    }
  })

  it("is disabled when the host's root is archived", () => {
    root = { archivedAt: "2026-10-01T00:00:00.000Z" }
    const { result } = renderHook(() => useCreateDoc("ws_1", { ...channel, rootStreamId: "stream_root" }))
    expect(result.current.enabled).toBe(false)
  })

  it("creates the doc with exactly its type and host, then opens it beside the host", async () => {
    const { result } = renderHook(() => useCreateDoc("ws_1", channel))
    await act(() => result.current.run())

    expect(mutateAsync.mock.calls).toEqual([[{ type: "doc", parentStreamId: "stream_host" }]])
    expect(openPanel.mock.calls).toEqual([["stream_doc", { beside: "stream_host" }]])
  })

  it.each([
    ["DOC_HOST_TYPE_INVALID", "Docs can't be created in this stream."],
    ["DOC_E2E_HOST_NOT_ALLOWED", "Docs can't be created in an encrypted stream."],
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
