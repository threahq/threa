import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, within } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ActiveAgentSession } from "@threahq/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  SidebarProvider,
  PanelProvider,
  CoordinatedLoadingProvider,
  ServicesProvider,
  TraceProvider,
  PendingMessagesProvider,
  PreferencesProvider,
} from "@/contexts"
import { AuthContext } from "@/auth/context"
import { UserProfileProvider } from "@/components/user-profile"
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import { seedAgentActivity, __resetAgentActivityStore } from "@/stores/agent-activity-store"
import { spyOnExport } from "@/test"
import * as timelineModule from "@/components/timeline"
import * as syncEngineModule from "@/sync/sync-engine"
import { StreamPage } from "./stream"

const workspaceId = "ws_1"
const streamId = "stream_open"
const threadStreamId = "stream_thread"

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    sessionId: "session_1",
    streamId,
    rootStreamId: streamId,
    parentAnchorId: null,
    personaName: "Ariadne",
    startedAt: "2026-04-19T12:00:00.000Z",
    currentStepType: "workspace_search",
    stepCount: 3,
    messageCount: 0,
    substep: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetAgentActivityStore()
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
    joinStream: vi.fn(),
    leaveStream: vi.fn(),
  } as never)
  // The page body is the whole virtualized timeline; the header is what's under test.
  spyOnExport(timelineModule, "TimelineView").mockReturnValue((() => <div data-testid="timeline" />) as never)
})

function renderStreamPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <AuthContext.Provider
      value={
        {
          user: { id: "usr_me", email: "me@example.com", name: "Me" },
          loading: false,
          error: null,
          login: () => {},
          logout: () => {},
          refetch: async () => {},
        } as never
      }
    >
      <SyncStatusContext.Provider value={new SyncStatusStore()}>
        <MemoryRouter initialEntries={[`/w/${workspaceId}/s/${streamId}`]}>
          <QueryClientProvider client={queryClient}>
            <ServicesProvider>
              <PendingMessagesProvider>
                <PreferencesProvider workspaceId={workspaceId}>
                  <TraceProvider>
                    <TooltipProvider>
                      <UserProfileProvider>
                        <SidebarProvider>
                          <PanelProvider>
                            <CoordinatedLoadingProvider workspaceId={workspaceId} streamIds={[streamId]}>
                              <Routes>
                                <Route path="/w/:workspaceId/s/:streamId" element={<StreamPage />} />
                              </Routes>
                            </CoordinatedLoadingProvider>
                          </PanelProvider>
                        </SidebarProvider>
                      </UserProfileProvider>
                    </TooltipProvider>
                  </TraceProvider>
                </PreferencesProvider>
              </PendingMessagesProvider>
            </ServicesProvider>
          </QueryClientProvider>
        </MemoryRouter>
      </SyncStatusContext.Provider>
    </AuthContext.Provider>
  )
}

function headerChip() {
  const header = document.querySelector("header")
  if (!header) throw new Error("stream header not rendered")
  return within(header).queryByRole("link", { name: /open agent trace/ })
}

describe("StreamPage header agent chip", () => {
  it("shows the chip for a session running in the stream the page has open", () => {
    seedAgentActivity(workspaceId, [session()])

    renderStreamPage()

    expect(headerChip()).toHaveAccessibleName("Ariadne is working — open agent trace")
  })

  it("stays idle for a session running in one of the stream's threads", () => {
    seedAgentActivity(workspaceId, [
      session({ streamId: threadStreamId, rootStreamId: streamId, parentAnchorId: "msg_anchor" }),
    ])

    renderStreamPage()

    expect(headerChip()).toBeNull()
  })
})
