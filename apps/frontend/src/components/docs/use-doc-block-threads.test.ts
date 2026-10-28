import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type Stream } from "@threahq/types"
import { docsApi } from "@/api/docs"
import * as contextsModule from "@/contexts"
import * as syncEngineModule from "@/sync/sync-engine"
import { SocketEventGate } from "@/sync/socket-event-gate"
import { useDocBlockThreads } from "./use-doc-block-threads"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"
const BLOCK_ID = `blk_${"0".repeat(25)}1`
const OTHER_BLOCK_ID = `blk_${"0".repeat(25)}2`

function threadUpdated(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    streamId: DOC_ID,
    parentStreamId: DOC_ID,
    anchorId: BLOCK_ID,
    threadId: "stream_thread",
    replyCount: 2,
    ...overrides,
  }
}

describe("useDocBlockThreads", () => {
  let gate: SocketEventGate

  beforeEach(() => {
    gate = new SocketEventGate(WORKSPACE_ID)
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null)
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue({
      getLiveEventSource: () => gate,
    } as unknown as ReturnType<typeof syncEngineModule.useOptionalSyncEngine>)
    vi.spyOn(docsApi, "listThreads").mockResolvedValue({
      threads: [{ blockId: BLOCK_ID, threadId: "stream_thread", replyCount: 1 }],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function mountLoaded(joinCount = 1) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const view = renderHook(
      (props: { joinCount: number }) => useDocBlockThreads(WORKSPACE_ID, DOC_ID, props.joinCount),
      {
        wrapper,
        initialProps: { joinCount },
      }
    )
    if (joinCount > 0) await waitFor(() => expect(view.result.current.size).toBe(1))
    return view
  }

  it("should read the doc's threads keyed by block", async () => {
    const { result } = await mountLoaded()
    expect(Object.fromEntries(result.current)).toEqual({ [BLOCK_ID]: { threadId: "stream_thread", replyCount: 1 } })
  })

  it("should not read before the doc room join is acked", async () => {
    const { result } = await mountLoaded(0)
    expect({ size: result.current.size, reads: vi.mocked(docsApi.listThreads).mock.calls.length }).toEqual({
      size: 0,
      reads: 0,
    })
  })

  it("should apply a reply count from this doc's thread:updated", async () => {
    const { result } = await mountLoaded()

    await act(() => gate.dispatch("thread:updated", threadUpdated()))

    await waitFor(() => expect(result.current.get(BLOCK_ID)).toEqual({ threadId: "stream_thread", replyCount: 2 }))
  })

  it("should ignore a thread:updated for another stream", async () => {
    const { result } = await mountLoaded()

    await act(async () => {
      await gate.dispatch(
        "thread:updated",
        threadUpdated({ streamId: "stream_other", parentStreamId: "stream_other", anchorId: OTHER_BLOCK_ID })
      )
      await gate.dispatch("thread:updated", threadUpdated())
    })

    await waitFor(() =>
      expect(Object.fromEntries(result.current)).toEqual({ [BLOCK_ID]: { threadId: "stream_thread", replyCount: 2 } })
    )
  })

  it("should read again when a thread event lands during a read", async () => {
    let answerStale!: () => void
    vi.mocked(docsApi.listThreads)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerStale = () => resolve({ threads: [{ blockId: BLOCK_ID, threadId: "stream_thread", replyCount: 1 }] })
          })
      )
      .mockResolvedValueOnce({ threads: [{ blockId: BLOCK_ID, threadId: "stream_thread", replyCount: 2 }] })
    const view = await mountLoaded(0)
    view.rerender({ joinCount: 1 })
    await waitFor(() => expect(docsApi.listThreads).toHaveBeenCalledTimes(1))

    await act(() => gate.dispatch("thread:updated", threadUpdated()))
    await act(async () => answerStale())

    await waitFor(() =>
      expect({
        threads: Object.fromEntries(view.result.current),
        reads: vi.mocked(docsApi.listThreads).mock.calls.length,
      }).toEqual({ threads: { [BLOCK_ID]: { threadId: "stream_thread", replyCount: 2 } }, reads: 2 })
    )
  })

  it("should add a thread created on another block of this doc", async () => {
    const { result } = await mountLoaded()
    const stream = {
      id: "stream_new",
      type: StreamTypes.THREAD,
      parentStreamId: DOC_ID,
      parentAnchorId: OTHER_BLOCK_ID,
      replyCount: 0,
    } as Stream

    await act(() => gate.dispatch("stream:created", { workspaceId: WORKSPACE_ID, streamId: DOC_ID, stream }))

    await waitFor(() => expect(result.current.get(OTHER_BLOCK_ID)).toEqual({ threadId: "stream_new", replyCount: 0 }))
  })

  it("should read the threads again when the doc room is rejoined", async () => {
    const view = await mountLoaded()
    vi.mocked(docsApi.listThreads).mockResolvedValue({
      threads: [{ blockId: BLOCK_ID, threadId: "stream_thread", replyCount: 5 }],
    })

    view.rerender({ joinCount: 2 })

    await waitFor(() => expect(view.result.current.get(BLOCK_ID)).toEqual({ threadId: "stream_thread", replyCount: 5 }))
  })
})
