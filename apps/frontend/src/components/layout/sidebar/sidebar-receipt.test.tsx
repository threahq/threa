import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, userEvent } from "@/test"
import { SettingsProvider } from "@/contexts"
import { SidebarReceiptRow, settledByRule, type SidebarReceipt } from "./sidebar-receipt"

function renderReceipt(receipt: SidebarReceipt, props: { onUndo?: () => void; onDismiss?: () => void } = {}) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_1"]}>
      <SettingsProvider>
        <SidebarReceiptRow
          receipt={receipt}
          streamName="#launch"
          labelName="Design"
          onUndo={props.onUndo}
          onDismiss={props.onDismiss ?? vi.fn()}
        />
      </SettingsProvider>
    </MemoryRouter>
  )
}

describe("SidebarReceiptRow", () => {
  it("says which label went and the rule that removed it, with Undo and a gear to that rule", async () => {
    const onUndo = vi.fn()
    renderReceipt({ kind: "label-removed", streamId: "stream_1", labelId: "label_1" }, { onUndo })

    expect({
      status: screen.getByRole("status").textContent,
      gear: screen.getByRole("link", { name: "Label settings" }).getAttribute("href"),
    }).toEqual({
      status: "Removed “Design” from #launchRemoves the old label",
      gear: "/w/ws_1/s/stream_1?settings=inbox&setting=label-move",
    })

    await userEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(onUndo).toHaveBeenCalledOnce()
  })

  it("explains a settle by the viewer's settling rule and links to it, without Undo", async () => {
    const onDismiss = vi.fn()
    renderReceipt({ kind: "settled", streamId: "stream_1", mode: "interaction" }, { onDismiss })

    expect({
      title: screen.getByText("Settled #launch").textContent,
      rule: screen.getByText("Leaves Inbox when you reply or react").textContent,
      undo: screen.queryByRole("button", { name: "Undo" }),
      gear: screen.getByRole("link", { name: "Inbox settings" }).getAttribute("href"),
    }).toEqual({
      title: "Settled #launch",
      rule: "Leaves Inbox when you reply or react",
      undo: null,
      gear: "/w/ws_1/s/stream_1?settings=inbox&setting=settling",
    })

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe("settledByRule", () => {
  const inbox = new Set(["stream_open", "stream_other"])
  const base = {
    before: inbox,
    after: new Set(["stream_other"]),
    activeStreamId: "stream_open",
    settledByHand: new Set<string>(),
    stillListed: () => true,
  }

  it("names the open stream when it left the Inbox on its own", () => {
    expect(settledByRule(base)).toBe("stream_open")
  })

  it("stays quiet for a hand-settle, another stream, a stream that left the sidebar, or one still in the Inbox", () => {
    expect({
      byHand: settledByRule({ ...base, settledByHand: new Set(["stream_open"]) }),
      otherStream: settledByRule({ ...base, after: new Set(["stream_open"]) }),
      unlisted: settledByRule({ ...base, stillListed: () => false }),
      stillThere: settledByRule({ ...base, after: inbox }),
      neverInInbox: settledByRule({ ...base, before: new Set(["stream_other"]) }),
      noStreamOpen: settledByRule({ ...base, activeStreamId: undefined }),
    }).toEqual({
      byHand: null,
      otherStream: null,
      unlisted: null,
      stillThere: null,
      neverInInbox: null,
      noStreamOpen: null,
    })
  })
})
