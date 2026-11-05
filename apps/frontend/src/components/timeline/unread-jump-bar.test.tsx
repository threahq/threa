import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { SettingsProvider } from "@/contexts"
import { UnreadJumpBar } from "./stream-read-tracker"

describe("UnreadJumpBar", () => {
  it("links to the unread landing setting beside the jump and dismiss controls", async () => {
    const onJump = vi.fn()
    render(
      <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
        <SettingsProvider>
          <UnreadJumpBar unreadCount={3} onJump={onJump} onMarkAllRead={vi.fn()} />
        </SettingsProvider>
      </MemoryRouter>
    )

    await userEvent.click(screen.getByRole("button", { name: /3 new messages/ }))

    expect({
      jumped: onJump.mock.calls.length,
      href: screen.getByRole("link", { name: "Unread settings" }).getAttribute("href"),
    }).toEqual({ jumped: 1, href: "/w/ws_1/s/stream_1?settings=messages&setting=unread-landing" })
  })

  it("offers no settings link outside the workspace shell", () => {
    render(<UnreadJumpBar unreadCount={1} onJump={vi.fn()} onMarkAllRead={vi.fn()} />)

    expect(screen.queryByRole("link", { name: "Unread settings" })).toBeNull()
  })
})
