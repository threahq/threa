import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StreamTypes, Visibilities, type Stream } from "@threahq/types"
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
import { STREAM_SETTINGS_PARAM, STREAM_SETTINGS_SID_PARAM } from "@/contexts/settings-context"
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import { spyOnExport } from "@/test"
import * as callModule from "@/components/call"
import * as timelineModule from "@/components/timeline"
import * as hooksModule from "@/hooks"
import type { VirtualStream } from "@/hooks/use-stream-or-draft"
import * as syncEngineModule from "@/sync/sync-engine"
import { PanesPage } from "@/pages/panes"

const workspaceId = "ws_1"
const streamId = "stream_open"

const CHANNEL = {
  id: streamId,
  workspaceId,
  type: StreamTypes.CHANNEL,
  displayName: "launch",
  slug: "launch",
  description: null,
  visibility: Visibilities.PUBLIC,
  parentStreamId: null,
  rootStreamId: null,
  companionMode: "off",
  companionPersonaId: null,
  createdBy: "usr_me",
  createdAt: "2026-06-17T10:00:00Z",
  updatedAt: "2026-06-17T10:00:00Z",
  archivedAt: null,
} as Stream

function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({ joinStream: vi.fn(), leaveStream: vi.fn() } as never)
  spyOnExport(timelineModule, "StreamContent").mockReturnValue((() => <div data-testid="timeline" />) as never)
  spyOnExport(callModule, "useCallStart").mockReturnValue(() => ({
    callActive: false,
    width: 0,
    start: vi.fn(),
    takeOver: null,
  }))
  spyOnExport(callModule, "CallStartMenu").mockReturnValue((() => null) as never)
  spyOnExport(callModule, "RejoinBar").mockReturnValue((() => null) as never)
  spyOnExport(hooksModule, "useStreamOrDraft").mockReturnValue(() => ({
    stream: { ...CHANNEL, isDraft: false } as VirtualStream,
    isLoading: false,
    isDraft: false,
    error: null,
    rename: vi.fn(),
    canRename: false,
    renamePending: false,
    renameError: null,
    archive: vi.fn(),
    sendMessage: vi.fn(),
    currentUserId: "usr_me",
    archivedAncestor: null,
  }))
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
                                <Route path="/w/:workspaceId/s/:streamId" element={<PanesPage />} />
                              </Routes>
                              <SearchProbe />
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

describe("Stream header settings gear", () => {
  it("is named Stream settings, with its own glyph, and opens this stream's General page", async () => {
    renderStreamPage()
    const header = document.querySelector("header")
    if (!header) throw new Error("stream header not rendered")

    const gear = within(header).getByRole("button", { name: "Stream settings" })
    expect({
      tooltip: gear.getAttribute("title"),
      glyph: gear.querySelector("svg")?.classList.contains("lucide-sliders-horizontal"),
    }).toEqual({ tooltip: "Stream settings", glyph: true })
    await userEvent.click(gear)

    const params = new URLSearchParams(screen.getByTestId("search").textContent ?? "")
    expect({ page: params.get(STREAM_SETTINGS_PARAM), sid: params.get(STREAM_SETTINGS_SID_PARAM) }).toEqual({
      page: "general",
      sid: streamId,
    })
  })
})
