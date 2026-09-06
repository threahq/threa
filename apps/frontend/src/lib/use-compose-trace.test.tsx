import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FeatureFlagLayers, WorkspaceBootstrap } from "@threahq/types"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useComposeTrace } from "./compose-trace"

const workspaceId = "ws_1"
const streamId = "stream_1"

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function clientWithFlag(value: "off" | "capture" | undefined): QueryClient {
  const queryClient = new QueryClient()
  const layers: FeatureFlagLayers = { workspace: value ? { composeTraces: value } : {}, user: {} }
  queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), { featureFlags: layers } as WorkspaceBootstrap)
  return queryClient
}

function renderTrace(queryClient: QueryClient, hasDraftContent = () => false) {
  return renderHook(
    ({ horizonStreamId, draftReady }: { horizonStreamId: string | undefined; draftReady: boolean }) =>
      useComposeTrace({ workspaceId, scopeId: streamId, horizonStreamId, hasDraftContent, draftReady }),
    {
      wrapper: wrapper(queryClient),
      initialProps: { horizonStreamId: streamId as string | undefined, draftReady: true },
    }
  )
}

async function seedEvent(id: string, stream: string, sequence: number) {
  await db.events.put({
    id,
    streamId: stream,
    workspaceId,
    sequence: String(sequence),
    eventType: "message_created",
    payload: { messageId: id, contentMarkdown: "hi" },
    actorId: "usr_1",
    actorType: "user",
    createdAt: new Date().toISOString(),
    _sequenceNum: sequence,
    _cachedAt: Date.now(),
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("useComposeTrace", () => {
  it("captures the session when the workspace is set to capture", async () => {
    await db.events.clear()
    await seedEvent("evt_1", streamId, 77)

    const { result } = renderTrace(clientWithFlag("capture"), () => true)

    await act(async () => result.current.onComposerFocus())
    const trace = await result.current.takeComposeTrace()

    expect({ ...trace, openedAt: typeof trace?.openedAt }).toEqual({
      horizonStreamId: streamId,
      openedAt: "string",
      openedAtSequence: 77,
      sentAtSequence: 77,
      resumedDraft: true,
    })
  })

  it("holds the focus until the draft has hydrated, so a resumed draft reports as resumed", async () => {
    await db.events.clear()
    await seedEvent("evt_1", streamId, 77)
    let draftLoaded = false

    const { result, rerender } = renderTrace(clientWithFlag("capture"), () => draftLoaded)
    rerender({ horizonStreamId: streamId, draftReady: false })
    // Autofocus fires during mount, before the persisted draft lands.
    await act(async () => result.current.onComposerFocus())
    expect(await result.current.takeComposeTrace()).toBeUndefined()

    const hydratedAt = new Date().toISOString()
    draftLoaded = true
    await act(async () => {
      rerender({ horizonStreamId: streamId, draftReady: true })
    })
    const trace = await result.current.takeComposeTrace()

    expect({ resumedDraft: trace?.resumedDraft, afterHydration: (trace?.openedAt ?? "") >= hydratedAt }).toEqual({
      resumedDraft: true,
      afterHydration: true,
    })
  })

  it("opens no session while the horizon stream is unresolved", async () => {
    const { result, rerender } = renderTrace(clientWithFlag("capture"), () => true)
    rerender({ horizonStreamId: undefined, draftReady: true })
    await act(async () => result.current.onComposerFocus())

    expect(await result.current.takeComposeTrace()).toBeUndefined()
  })

  it("drops the session when the horizon stream changes under the same scope", async () => {
    await db.events.clear()
    await seedEvent("evt_1", streamId, 77)
    await seedEvent("evt_2", "stream_2", 5)

    const { result, rerender } = renderTrace(clientWithFlag("capture"), () => false)
    await act(async () => result.current.onComposerFocus())
    await act(async () => {
      rerender({ horizonStreamId: "stream_2", draftReady: true })
    })

    expect(await result.current.takeComposeTrace()).toBeUndefined()
  })

  it("captures nothing — and touches no IDB — while the flag is off", async () => {
    const readEvents = vi.spyOn(db.events, "where")

    const { result } = renderTrace(clientWithFlag("off"), () => true)
    await act(async () => result.current.onComposerFocus())

    expect(await result.current.takeComposeTrace()).toBeUndefined()
    expect(readEvents).not.toHaveBeenCalled()
  })

  it("defaults to no capture when the workspace carries no override", async () => {
    const { result } = renderTrace(clientWithFlag(undefined))
    await act(async () => result.current.onComposerFocus())

    expect(await result.current.takeComposeTrace()).toBeUndefined()
  })
})
