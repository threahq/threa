import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes, matchRoutes, useLocation } from "react-router-dom"
import { APP_LINK_PAGES } from "@threahq/types"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import * as notificationsSettingsModule from "@/components/settings/notifications-settings"
import * as scheduleSettingsModule from "@/components/settings/schedule-settings"
import * as quietHoursModule from "@/components/settings/quiet-hours-setting"
import { SettingsProvider } from "@/contexts"
import * as workspaceStore from "@/stores/workspace-store"
import * as workspacesModule from "@/hooks/use-workspaces"
import { router } from "@/routes"

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>
}

function renderMarkdown(content: string, route = "/w/ws_1/s/stream_here?m=msg_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <SettingsProvider>
                <MarkdownContent content={content} />
                <SettingsDialog />
              </SettingsProvider>
            }
          />
          <Route path="/outside" element={<MarkdownContent content={content} />} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("app: links in markdown", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue([])
    vi.spyOn(workspaceStore, "useWorkspaceUsers").mockReturnValue([])
    vi.spyOn(workspaceStore, "useWorkspaceDmPeers").mockReturnValue([])
    vi.spyOn(workspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
    vi.spyOn(notificationsSettingsModule, "NotificationsSettings").mockImplementation(() => (
      <div>Notifications panel</div>
    ))
    vi.spyOn(scheduleSettingsModule, "ScheduleSettings").mockImplementation(() => <div>Schedule panel</div>)
    vi.spyOn(quietHoursModule, "QuietHoursSetting").mockImplementation(() => <div>Quiet hours panel</div>)
  })

  it("should open the settings dialog on its tab over the current view when the chip is clicked", async () => {
    renderMarkdown("Change it in [Notifications](app:settings/notifications).")

    await userEvent.click(screen.getByRole("link", { name: "Notifications" }))

    expect(await screen.findByText("Notifications panel")).toBeVisible()
    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws_1/s/stream_here?m=msg_1&settings=notifications")
  })

  it("should open a page from a legacy workspace-settings link in the one settings window", async () => {
    renderMarkdown("Admins manage them under [Bots](app:workspace-settings/bots).")

    await userEvent.click(screen.getByRole("link", { name: "Bots" }))

    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws_1/s/stream_here?m=msg_1&settings=bots")
  })

  it("should navigate to a workspace page when the chip is clicked", async () => {
    renderMarkdown("Browse it in [Memory](app:memory).")

    await userEvent.click(screen.getByRole("link", { name: "Memory" }))

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/w\/ws_1\/memory$/)
  })

  it("should render an unknown destination as plain text", () => {
    renderMarkdown("Open [the moon](app:moon) now.")

    expect(screen.queryByRole("link", { name: "the moon" })).toBeNull()
    expect(screen.getByText("the moon").tagName).toBe("SPAN")
  })

  it("should render as plain text outside a workspace", () => {
    renderMarkdown("Open [Memory](app:memory).", "/outside")

    expect(screen.queryByRole("link", { name: "Memory" })).toBeNull()
    expect(screen.getByText("Memory")).toBeInTheDocument()
  })

  it("should keep settings chips inert without a settings provider", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/w/ws_1"]}>
          <Routes>
            <Route
              path="/w/:workspaceId"
              element={
                <MarkdownContent content="[Notifications](app:settings/notifications) or [Memory](app:memory)" />
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )

    expect(screen.queryByRole("link", { name: "Notifications" })).toBeNull()
    expect(screen.getByRole("link", { name: "Memory" })).toBeInTheDocument()
  })

  it("should open settings over the current view when a same-origin /go link is clicked", async () => {
    renderMarkdown(`Change it in [Notifications](${window.location.origin}/go/settings/notifications).`)

    await userEvent.click(screen.getByRole("link", { name: "Notifications" }))

    expect(await screen.findByText("Notifications panel")).toBeVisible()
    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws_1/s/stream_here?m=msg_1&settings=notifications")
  })

  it("should open a page in the current workspace when a same-origin /go link is clicked", async () => {
    renderMarkdown(`Browse it in [Memory](${window.location.origin}/go/memory).`)

    await userEvent.click(screen.getByRole("link", { name: "Memory" }))

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/w\/ws_1\/memory$/)
  })

  it("should name a bare same-origin /go URL after its destination", () => {
    const origin = window.location.origin
    renderMarkdown(`${origin}/go/settings/ai and ${origin}/go/workspace-settings/bots and ${origin}/go/board`)

    expect(screen.getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Settings: Your AI", "/w/ws_1/s/stream_here?m=msg_1&settings=ai"],
      ["Settings: Shared bots", "/w/ws_1/s/stream_here?m=msg_1&settings=bots"],
      ["Board", "/w/ws_1/board"],
    ])
  })

  it("should leave a same-origin /go link to the redirect route outside a workspace", async () => {
    renderMarkdown(`Browse it in [Memory](${window.location.origin}/go/memory).`, "/outside")

    await userEvent.click(screen.getByRole("link", { name: "Memory" }))

    expect(screen.getByTestId("location")).toHaveTextContent(/^\/go\/memory$/)
  })

  it("should point every page destination at a workspace route", () => {
    const unrouted = APP_LINK_PAGES.filter((page) => {
      const leaf = matchRoutes(router.routes, `/w/ws_1/${page}`)?.at(-1)?.route.path
      return leaf === undefined || leaf.startsWith(":") || leaf === "*"
    })

    expect(unrouted).toEqual([])
  })
})
