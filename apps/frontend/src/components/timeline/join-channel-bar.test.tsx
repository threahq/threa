import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { streamsApi } from "@/api"
import { JoinChannelBar } from "./join-channel-bar"
import type { StreamMember } from "@threa/types"

const mockJoin = vi.fn()

const mockMembership: StreamMember = {
  streamId: "stream_1",
  memberId: "member_1",
  notificationLevel: null,
  lastReadEventId: null,
  lastReadAt: null,
  joinedAt: "2025-01-01T00:00:00Z",
}

describe("JoinChannelBar", () => {
  const defaultProps = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    channelName: "general",
    onJoined: vi.fn(),
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
    mockJoin.mockReset()
    mockJoin.mockResolvedValue(mockMembership)
    vi.spyOn(streamsApi, "join").mockImplementation((...args: Parameters<typeof streamsApi.join>) => mockJoin(...args))
  })

  it("should render channel name and join button", () => {
    render(<JoinChannelBar {...defaultProps} />)

    expect(screen.getByText("general")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Join Channel" })).toBeInTheDocument()
  })

  it("should call streamsApi.join when button is clicked", async () => {
    render(<JoinChannelBar {...defaultProps} />)

    await userEvent.click(screen.getByRole("button", { name: "Join Channel" }))

    expect(mockJoin).toHaveBeenCalledWith("ws_1", "stream_1")
  })

  it("should call onJoined with membership on success", async () => {
    render(<JoinChannelBar {...defaultProps} />)

    await userEvent.click(screen.getByRole("button", { name: "Join Channel" }))

    await waitFor(() => {
      expect(defaultProps.onJoined).toHaveBeenCalledWith(mockMembership)
    })
  })

  it("should show 'Joining...' while request is in flight", async () => {
    let resolveJoin: (value: StreamMember) => void
    mockJoin.mockReturnValue(
      new Promise<StreamMember>((resolve) => {
        resolveJoin = resolve
      })
    )

    render(<JoinChannelBar {...defaultProps} />)

    await userEvent.click(screen.getByRole("button", { name: "Join Channel" }))

    expect(screen.getByRole("button", { name: "Joining..." })).toBeDisabled()

    resolveJoin!(mockMembership)
  })

  it("should show error message when join fails", async () => {
    mockJoin.mockRejectedValue(new Error("Forbidden"))

    render(<JoinChannelBar {...defaultProps} />)

    await userEvent.click(screen.getByRole("button", { name: "Join Channel" }))

    await waitFor(() => {
      expect(screen.getByText("Forbidden")).toBeInTheDocument()
    })
    expect(defaultProps.onJoined).not.toHaveBeenCalled()
  })

  // The composer is not rendered for non-members, so the join bar must own
  // `--composer-height` while it is mounted. Otherwise the timeline footer
  // spacer keeps a stale height and the bar floats over the messages instead
  // of docking flush at the bottom (the "join channel is fucked" bug).
  it("should publish its height as --composer-height on the editor zone", () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { height: 96, width: 0, top: 0, left: 0, right: 0, bottom: 96, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
    try {
      const { container } = render(
        <div data-editor-zone="main">
          <JoinChannelBar {...defaultProps} />
        </div>
      )
      const zone = container.querySelector<HTMLElement>("[data-editor-zone]")!
      expect(zone.style.getPropertyValue("--composer-height")).toBe("96px")
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original
    }
  })
})
