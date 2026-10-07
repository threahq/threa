import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { useRef } from "react"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, type Stream, type StreamEvent } from "@threahq/types"
import { spyOnExport } from "@/test"
import { createMockStream } from "@/test/fixtures"
import { createMockUser } from "@/test/fixtures/users"
import * as authModule from "@/auth"
import * as contextsModule from "@/contexts"
import { CoordinatedLoadingProvider, PanelProvider, PendingMessagesProvider, ServicesProvider } from "@/contexts"
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as useUnreadCountsModule from "@/hooks/use-unread-counts"
import * as useMobileModule from "@/hooks/use-mobile"
import * as usePointerModule from "@/hooks/use-pointer"
import { ReadCommitQueue, ReadCommitQueueContext } from "@/sync/read-commit-queue"
import * as messageInputModule from "./message-input"
import * as trackerModule from "./stream-read-tracker"
import { StreamContent } from "./stream-content"

const WORKSPACE_ID = "ws_1"
const RealTracker = trackerModule.StreamReadTracker
const viewer = createMockUser({ id: "usr_viewer", workosUserId: "workos_viewer", role: "member" })

const streamA = createMockStream({ id: "stream_a", type: StreamTypes.CHANNEL, workspaceId: WORKSPACE_ID })
const streamB = createMockStream({ id: "stream_b", type: StreamTypes.CHANNEL, workspaceId: WORKSPACE_ID })

function makeEvents(prefix: string): StreamEvent[] {
  return [0, 1, 2].map((n) => ({
    id: `${prefix}${n}`,
    sequence: String(n),
    eventType: "message_created",
  })) as unknown as StreamEvent[]
}

interface Fixture {
  events: StreamEvent[]
  lastReadEventId: string
  unreadCount: number
}

const fixtures: Record<string, Fixture> = {}

function resetFixtures() {
  fixtures[streamA.id] = { events: makeEvents("a"), lastReadEventId: "a0", unreadCount: 2 }
  // Pointer already at the tail: B has nothing new for the scan to advance to.
  fixtures[streamB.id] = { events: makeEvents("b"), lastReadEventId: "b2", unreadCount: 0 }
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect
}

const VIEWPORT_RECT = rect(0, 100)
const ROW_RECTS = [rect(-50, -10), rect(10, 50), rect(50, 90)]

// Occupies StreamContent's tracker slot so its key applies; renders the real tracker over stubbed geometry.
function TrackerSlot(props: React.ComponentProps<typeof RealTracker>) {
  const fixture = fixtures[props.streamId]
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={(el) => {
        containerRef.current = el
        if (el) el.getBoundingClientRect = () => VIEWPORT_RECT
      }}
    >
      {fixture.events.map((event, i) => (
        <div
          key={event.id}
          data-event-id={event.id}
          ref={(el) => {
            if (el) el.getBoundingClientRect = () => ROW_RECTS[i]
          }}
        />
      ))}
      <RealTracker
        {...props}
        scrollContainerRef={containerRef}
        scrollContainerEl={null}
        contentRef={undefined}
        events={fixture.events}
        lastReadEventId={fixture.lastReadEventId}
        lastReadSequence={null}
        hasOlderEvents={false}
        enabled
      />
    </div>
  )
}

let queue: ReadCommitQueue
const commit = vi.fn<ReadCommitQueue["commitRef"]["current"]>()

function renderContent(stream: Stream) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const syncStatus = new SyncStatusStore()
  const tree = (current: Stream) => (
    <QueryClientProvider client={queryClient}>
      <ServicesProvider>
        <PendingMessagesProvider>
          <ReadCommitQueueContext.Provider value={queue}>
            <MemoryRouter>
              <SyncStatusContext.Provider value={syncStatus}>
                <PanelProvider>
                  <CoordinatedLoadingProvider workspaceId={WORKSPACE_ID} streamIds={[]}>
                    <StreamContent workspaceId={WORKSPACE_ID} streamId={current.id} stream={current} />
                  </CoordinatedLoadingProvider>
                </PanelProvider>
              </SyncStatusContext.Provider>
            </MemoryRouter>
          </ReadCommitQueueContext.Provider>
        </PendingMessagesProvider>
      </ServicesProvider>
    </QueryClientProvider>
  )
  const view = render(tree(stream))
  return { switchTo: (next: Stream) => view.rerender(tree(next)) }
}

beforeEach(() => {
  resetFixtures()
  vi.useFakeTimers()
  // Synchronous rAF returning 0: a truthy id would wedge the scan's schedule guard.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )

  commit.mockReset()
  commit.mockResolvedValue({ applied: true })
  queue = new ReadCommitQueue({ commitRef: { current: commit } })

  vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
    preferences: { keyboardShortcuts: {} },
  } as unknown as ReturnType<typeof contextsModule.usePreferences>)
  vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_viewer" } as ReturnType<typeof authModule.useUser>)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([viewer] as ReturnType<
    typeof workspaceStoreModule.useWorkspaceUsers
  >)
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockReturnValue([])
  vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(false)
  vi.spyOn(usePointerModule, "useCoarsePointer").mockReturnValue(false)
  vi.spyOn(document, "hasFocus").mockReturnValue(true)
  vi.spyOn(useUnreadCountsModule, "useStreamUnreadState").mockImplementation((_workspaceId, streamId) => {
    const unreadCount = fixtures[streamId]?.unreadCount ?? 0
    return { unreadCount, activityCount: 0, inInbox: unreadCount > 0 }
  })
  spyOnExport(messageInputModule, "MessageInput").mockReturnValue((() => null) as never)
  spyOnExport(trackerModule, "StreamReadTracker").mockReturnValue(TrackerSlot as never)
})

afterEach(() => {
  cleanup()
  vi.runOnlyPendingTimers()
  queue.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function settle(ms = 500) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe("StreamContent read tracking across a stream switch", () => {
  it("should flush the read earned in A and never submit A's event for B when the stream switches", () => {
    const { switchTo } = renderContent(streamA)
    settle(100)
    expect(commit).not.toHaveBeenCalled()

    switchTo(streamB)
    settle()

    expect(commit.mock.calls).toEqual([[streamA.id, "a2", { partial: false }]])
  })

  it("should mark the new stream's own unread event when the stream switches", () => {
    fixtures[streamB.id] = { events: makeEvents("b"), lastReadEventId: "b0", unreadCount: 2 }
    const { switchTo } = renderContent(streamA)

    switchTo(streamB)
    settle()

    expect(commit.mock.calls).toEqual([
      [streamA.id, "a2", { partial: false }],
      [streamB.id, "b2", { partial: false }],
    ])
  })
})
