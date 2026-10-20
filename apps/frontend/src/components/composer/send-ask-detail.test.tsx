import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { SendAskDetail } from "./send-ask-detail"

const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const COPY = {
  full: "Ada can't open this link",
  short: "Ada can't open it",
  alternative: null,
  primary: { full: "Send anyway", short: "Send" },
}

function emptyWorkspaceCache() {
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue(
    [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockReturnValue(
    [] as unknown as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
}

describe("SendAskDetail", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.removeAttribute("style")
  })

  it("keeps presses inside the popover out of the composer's focus guard, and lists no one it can't name", async () => {
    emptyWorkspaceCache()
    render(
      <div onMouseDown={(event) => event.preventDefault()}>
        <SendAskDetail
          workspaceId="ws_1"
          tone="unreachable"
          lead={{ streamId: "stream_src", count: 3, sampleUserIds: ["usr_unknown"] }}
          copy={COPY}
          compact={false}
          onPrimary={() => {}}
        >
          Ada can't open it
        </SendAskDetail>
      </div>
    )
    await userEvent.click(screen.getByTestId("send-ask-detail-trigger"))
    const detail = await screen.findByTestId("send-ask-detail")

    expect({
      pressKeptDefault: fireEvent.mouseDown(detail.querySelector("p")!),
      list: detail.querySelector("ul"),
    }).toEqual({ pressKeptDefault: true, list: null })
  })

  it("closing the sheet inside another drawer leaves that drawer's body styles alone", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(SAFARI_UA)
    emptyWorkspaceCache()
    render(
      <Drawer>
        <DrawerTrigger>Edit</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Edit message</DrawerTitle>
          <SendAskDetail
            workspaceId="ws_1"
            tone="unreachable"
            lead={{ streamId: "stream_src", count: 1, sampleUserIds: [] }}
            copy={COPY}
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
