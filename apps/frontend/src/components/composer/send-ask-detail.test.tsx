import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { SendAskDetail } from "./send-ask-detail"

const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

describe("SendAskDetail", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.removeAttribute("style")
  })

  it("closing the sheet inside another drawer leaves that drawer's body styles alone", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(SAFARI_UA)
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
    )
    vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
      [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
    )
    render(
      <Drawer>
        <DrawerTrigger>Edit</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Edit message</DrawerTitle>
          <SendAskDetail
            workspaceId="ws_1"
            tone="unreachable"
            lead={{ streamId: "stream_src", count: 1, sampleUserIds: [] }}
            copy={{
              full: "Ada can't open this link",
              short: "Ada can't open it",
              alternative: null,
              primary: { full: "Send anyway", short: "Send" },
            }}
            compact
            onPrimary={() => {}}
          >
            Ada can't open it
          </SendAskDetail>
        </DrawerContent>
      </Drawer>
    )
    await userEvent.click(screen.getByRole("button", { name: "Edit" }))
    await waitFor(() => expect(document.body.style.position).toBe("fixed"))

    // A pointer press inside a vaul sheet starts a drag jsdom cannot measure.
    fireEvent.click(screen.getByTestId("send-ask-detail-trigger"))
    expect(screen.getByRole("dialog", { name: "Ada can't open this link" })).toContainElement(
      screen.getByTestId("send-ask-detail")
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.getByTestId("send-ask-detail-trigger").getAttribute("aria-expanded")).toBe("false")
    )

    expect(document.body.style.position).toBe("fixed")
  })
})
