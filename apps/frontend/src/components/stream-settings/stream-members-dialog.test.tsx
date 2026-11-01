import { beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, useLocation } from "react-router-dom"
import { fireEvent, render, screen } from "@/test"
import { StreamMembersDialog } from "./stream-members-dialog"
import * as membersTabModule from "./members-tab"
import * as useStreamNameModule from "@/hooks/use-stream-name"
import * as useCurrentWorkspaceUserIdModule from "@/hooks/use-current-workspace-user-id"

function LocationSearchEcho() {
  const location = useLocation()
  return <div data-testid="location-search">{location.search}</div>
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/w/ws_1/s/stream_general${search}`]}>
      <StreamMembersDialog workspaceId="ws_1" />
      <LocationSearchEcho />
    </MemoryRouter>
  )
}

describe("StreamMembersDialog", () => {
  const membersTab = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    membersTab.mockReset()
    vi.spyOn(membersTabModule, "MembersTab").mockImplementation(((props: unknown) => {
      membersTab(props)
      return <div>Members panel</div>
    }) as unknown as typeof membersTabModule.MembersTab)
    vi.spyOn(useStreamNameModule, "useStreamName").mockImplementation(((_: string, streamId: string) =>
      streamId === "stream_general" ? "#general" : null) as unknown as typeof useStreamNameModule.useStreamName)
    vi.spyOn(useCurrentWorkspaceUserIdModule, "useCurrentWorkspaceUserId").mockReturnValue("user_1")
  })

  it("hosts the settings Members tab for the stream named in the URL", () => {
    renderAt("?stream-members=stream_general")

    expect(screen.getByRole("dialog", { name: "#general" })).toBeInTheDocument()
    expect(membersTab).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", streamId: "stream_general", currentUserId: "user_1" })
    )
  })

  it("stays closed without the URL param and drops it on close", () => {
    const { unmount } = renderAt("")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(membersTab).not.toHaveBeenCalled()
    unmount()

    renderAt("?stream-members=stream_general&panel=stream_x")
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(screen.getByTestId("location-search")).toHaveTextContent("?panel=stream_x")
  })
})
