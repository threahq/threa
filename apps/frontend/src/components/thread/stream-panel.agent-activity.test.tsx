import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
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
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import { seedAgentActivity, resetAgentActivityStore } from "@/stores/agent-activity-store"
import { spyOnExport } from "@/test"
import * as timelineModule from "@/components/timeline"
import { StreamPanel } from "./stream-panel"

const workspaceId = "ws_1"
const parentStreamId = "stream_parent"
const threadStreamId = "stream_thread"

function session(overrides: Partial<ActiveAgentSession> = {}): ActiveAgentSession {
  return {
    sessionId: "session_1",
    streamId: threadStreamId,
    rootStreamId: parentStreamId,
    parentAnchorId: "msg_anchor",
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
  resetAgentActivityStore()
  // The panel body is a whole timeline (socket, preferences, virtualizer); the
  // header is what's under test, so the body renders as a marker.
  spyOnExport(timelineModule, "StreamContent").mockReturnValue((() => <div data-testid="panel-body" />) as never)
})

function renderPanel(panel: string) {
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
        <MemoryRouter initialEntries={[`/w/${workspaceId}/s/${parentStreamId}?panel=${panel}`]}>
          <QueryClientProvider client={queryClient}>
            <ServicesProvider>
              <PendingMessagesProvider>
                <PreferencesProvider workspaceId={workspaceId}>
                  <TraceProvider>
                    <TooltipProvider>
                      <SidebarProvider>
                        <PanelProvider>
                          <CoordinatedLoadingProvider workspaceId={workspaceId} streamIds={[]}>
                            <Routes>
                              <Route
                                path="/w/:workspaceId/s/:streamId"
                                element={<StreamPanel workspaceId={workspaceId} onClose={() => {}} />}
                              />
                            </Routes>
                          </CoordinatedLoadingProvider>
                        </PanelProvider>
                      </SidebarProvider>
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
  if (!header) throw new Error("panel header not rendered")
  return within(header).queryByRole("link", { name: /open agent trace/ })
}

describe("StreamPanel header agent chip", () => {
  it("shows the chip for a session running in the panel's own stream", () => {
    seedAgentActivity(workspaceId, [session()])

    renderPanel(threadStreamId)

    expect(screen.getByTestId("panel-body")).toBeInTheDocument()
    expect(headerChip()).toHaveAccessibleName("Ariadne is working — open agent trace")
  })

  it("stays idle for a session running in the parent stream the thread hangs under", () => {
    seedAgentActivity(workspaceId, [session({ streamId: parentStreamId, parentAnchorId: null })])

    renderPanel(threadStreamId)

    expect(headerChip()).toBeNull()
  })

  it("stays idle on a draft panel, whose id is not a stream id", () => {
    seedAgentActivity(workspaceId, [session({ streamId: parentStreamId, parentAnchorId: null })])

    renderPanel(`draft:${parentStreamId}:msg_anchor`)

    expect(headerChip()).toBeNull()
  })
})
