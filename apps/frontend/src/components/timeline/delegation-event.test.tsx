import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { DelegationCreatedEventPayload, DelegationStatusChangedEventPayload, StreamEvent } from "@threa/types"
import { toast } from "sonner"
import * as hooksModule from "@/hooks"
import { PanelProvider } from "@/contexts"
import { delegationsApi } from "@/api"
import { buildDelegationPrompt, DelegationEvent } from "./delegation-event"

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ariadne",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
  vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(false)
  vi.spyOn(hooksModule, "useInputMode").mockReturnValue("mouse")
})

/** Healed thread stats (chunk-2) ride alongside the created payload on the card event. */
type CardPayload = DelegationCreatedEventPayload & {
  threadId?: string
  replyCount?: number
}

function createdEvent(payload: CardPayload): StreamEvent {
  return {
    id: "evt_dlg",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "delegation:created",
    actorId: "persona_system_ariadne",
    actorType: "persona",
    createdAt: new Date().toISOString(),
    payload,
  }
}

const CREATED_PAYLOAD: DelegationCreatedEventPayload = {
  delegationId: "dlg_1",
  title: "Add rate limiting to the webhook endpoint",
  brief: "Implement a token bucket. Done when the e2e suite passes.",
  contextRefs: ["memo:memo_1"],
  sourceConversationId: null,
}

async function selectCardAction(name: string | RegExp) {
  await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
  await userEvent.click(await screen.findByRole("menuitem", { name }))
}

function renderCard(
  statusPatch?: DelegationStatusChangedEventPayload,
  payloadOverride?: Partial<CardPayload>,
  isThreadParent = false
) {
  return render(
    <MemoryRouter initialEntries={["/w/ws_1"]}>
      <PanelProvider>
        <DelegationEvent
          event={createdEvent({ ...CREATED_PAYLOAD, ...payloadOverride })}
          workspaceId="ws_1"
          streamId="stream_1"
          statusPatch={statusPatch}
          isThreadParent={isThreadParent}
        />
      </PanelProvider>
    </MemoryRouter>
  )
}

describe("buildDelegationPrompt", () => {
  it("compiles title, brief, and context refs into one paste-ready prompt", () => {
    expect(buildDelegationPrompt(CREATED_PAYLOAD)).toBe(
      [
        "# Add rate limiting to the webhook endpoint",
        "",
        "Implement a token bucket. Done when the e2e suite passes.",
        "",
        "## Threa context refs",
        "- memo:memo_1",
      ].join("\n")
    )
  })

  it("omits the refs section when there are none", () => {
    const prompt = buildDelegationPrompt({ ...CREATED_PAYLOAD, contextRefs: [] })
    expect(prompt).not.toContain("Threa context refs")
  })
})

describe("DelegationEvent", () => {
  it("renders the open state with persistent mobile Copy and the full desktop action menu", async () => {
    renderCard()

    expect(screen.getByText("Add rate limiting to the webhook endpoint")).toBeInTheDocument()
    expect(screen.getByText(/Ariadne · Open/)).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /Copy prompt/ })[0]).toHaveClass("min-h-9", "sm:hidden")

    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "Mark done" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Cancel delegation" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "View result" })).not.toBeInTheDocument()
  })

  it("advances with the authoritative status patch: claimed shows the claimer label", async () => {
    renderCard({ delegationId: "dlg_1", status: "claimed", claimedByLabel: "Kris's MacBook / Claude Code" })

    expect(screen.getByText(/Ariadne · Claimed · Kris's MacBook \/ Claude Code/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "Cancel delegation" })).toBeInTheDocument()
  })

  it("shows the running progress note", () => {
    renderCard({ delegationId: "dlg_1", status: "running", statusNote: "tests are compiling" })

    expect(screen.getByText(/Ariadne · Running/)).toBeInTheDocument()
    expect(screen.getByText("tests are compiling")).toBeInTheDocument()
  })

  it("completed with threadStreamId: chip, quick action, and menu reach the thread", async () => {
    renderCard(
      {
        delegationId: "dlg_1",
        status: "completed",
        resultMessageId: "msg_result",
        threadStreamId: "stream_thread",
      },
      { threadId: "stream_thread", replyCount: 3 }
    )

    const chip = screen.getByRole("link", { name: /replies/ })
    expect(chip).toHaveTextContent("3 replies")
    expect(chip).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
    expect(screen.getByRole("link", { name: "View result" })).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
    expect(screen.queryByRole("link", { name: "Open thread" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "View result" })).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
    expect(screen.queryByRole("menuitem", { name: "Cancel delegation" })).not.toBeInTheDocument()
  })

  it("completed thread parent suppresses self-links in every action surface", async () => {
    renderCard(
      {
        delegationId: "dlg_1",
        status: "completed",
        resultMessageId: "msg_result",
        threadStreamId: "stream_thread",
      },
      { threadId: "stream_thread", replyCount: 3 },
      true
    )

    expect(screen.queryByRole("link", { name: /replies/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Open thread" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.queryByRole("menuitem", { name: "View result" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /thread/i })).not.toBeInTheDocument()
  })

  it("completed (legacy shape): menu falls back to the ?m= result deep-link", async () => {
    renderCard({ delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" })

    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.getByRole("menuitem", { name: "View result" })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?m=msg_result"
    )
    expect(screen.queryByRole("menuitem", { name: "Cancel delegation" })).not.toBeInTheDocument()
  })

  it("open card: desktop quick action opens a draft thread keyed on the card event", () => {
    renderCard()

    const discuss = screen.getByRole("link", { name: "Discuss in thread" })
    expect(discuss).toHaveAttribute("href", "/w/ws_1?panel=draft%3Astream_1%3Aevt_dlg")
  })

  it("renders the thread chip from the healed payload (replies land on the card's own event)", () => {
    renderCard(undefined, { threadId: "stream_thread", replyCount: 2 })

    const chip = screen.getByRole("link", { name: /replies/ })
    expect(chip).toHaveTextContent("2 replies")
    expect(chip).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
  })

  it.each(["failed", "expired"] as const)("%s is terminal: no Cancel action, status in meta", async (status) => {
    renderCard({ delegationId: "dlg_1", status })

    expect(screen.getByText(new RegExp(`Ariadne · ${status}`, "i"))).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.queryByRole("menuitem", { name: /Cancel delegation/ })).not.toBeInTheDocument()
  })

  it.each(["failed", "cancelled", "expired"] as const)(
    "%s card remains discussion-worthy when there's no thread yet",
    (status) => {
      renderCard({ delegationId: "dlg_1", status })

      const discuss = screen.getByRole("link", { name: "Discuss in thread" })
      expect(discuss).toHaveAttribute("href", "/w/ws_1?panel=draft%3Astream_1%3Aevt_dlg")
    }
  )

  it("cancelled reports terminal status and removes mutation actions", async () => {
    renderCard({ delegationId: "dlg_1", status: "cancelled" })

    expect(screen.getByText(/Ariadne · Cancelled/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.queryByRole("menuitem", { name: "Mark done" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Cancel delegation" })).not.toBeInTheDocument()
  })

  it("copies the compiled prompt and confirms in place with a checkmark (INV-63/21: no toast, same footprint)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const success = vi.spyOn(toast, "success")

    renderCard()
    await userEvent.click(screen.getAllByRole("button", { name: /Copy prompt/ })[0])

    expect(writeText).toHaveBeenCalledWith(
      buildDelegationPrompt(CREATED_PAYLOAD, { workspaceId: "ws_1", origin: window.location.origin })
    )
    expect(await screen.findAllByRole("button", { name: "Prompt copied" })).toHaveLength(2)
    expect(success).not.toHaveBeenCalled()
  })

  it("copies a shareable delegation link from the menu and confirms after the menu closes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const success = vi.spyOn(toast, "success")

    renderCard()
    await selectCardAction("Copy delegation link")

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/ws_1/delegations/dlg_1`)
    expect(success).toHaveBeenCalledWith("Delegation link copied")
  })

  it("marks the delegation done for paste-path work and relabels in place", async () => {
    const markDone = vi.spyOn(delegationsApi, "markDone").mockResolvedValue({ completed: true })

    renderCard()
    await selectCardAction("Mark done")

    expect(markDone).toHaveBeenCalledWith("ws_1", "dlg_1")
    await waitFor(() => expect(screen.getByText(/Ariadne · Completed/)).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.queryByRole("menuitem", { name: "Mark done" })).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Cancel delegation" })).not.toBeInTheDocument()
  })

  it("does not flip when mark-done lost the race; informs instead", async () => {
    vi.spyOn(delegationsApi, "markDone").mockResolvedValue({ completed: false })
    const info = vi.spyOn(toast, "info")

    renderCard()
    await selectCardAction("Mark done")

    await waitFor(() => expect(info).toHaveBeenCalled())
    expect(screen.getByText(/Ariadne · Open/)).toBeInTheDocument()
  })

  it("embeds the lifecycle breadcrumb (id + claim endpoint) in the compiled prompt", () => {
    const prompt = buildDelegationPrompt(CREATED_PAYLOAD, { workspaceId: "ws_1", origin: "https://threa.test" })
    expect(prompt).toContain("## Threa delegation lifecycle")
    expect(prompt).toContain("https://threa.test/api/v1/workspaces/ws_1/delegations/dlg_1/claim")
    expect(prompt).toContain("X-Threa-Callback-Token")
    expect(prompt).toContain('press "Mark done"')
  })

  it("cancels via the API and flips to Cancelled for the clicking member", async () => {
    const cancel = vi.spyOn(delegationsApi, "cancel").mockResolvedValue({ cancelled: true })

    renderCard()
    await selectCardAction("Cancel delegation")

    expect(cancel).toHaveBeenCalledWith("ws_1", "dlg_1")
    await waitFor(() => expect(screen.getByText(/Ariadne · Cancelled/)).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Card actions" }))
    expect(screen.queryByRole("menuitem", { name: "Cancel delegation" })).not.toBeInTheDocument()
  })

  it("does not flip when the cancel lost the race — the authoritative patch will land", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")
    vi.spyOn(delegationsApi, "cancel").mockResolvedValue({ cancelled: false })

    renderCard()
    await selectCardAction("Cancel delegation")

    await waitFor(() => expect(info).toHaveBeenCalled())
    expect(screen.getByText(/Ariadne · Open/)).toBeInTheDocument()
  })

  it("expands the hand-off prompt inline as source text", async () => {
    renderCard()

    await userEvent.click(screen.getByRole("button", { name: /Show hand-off prompt/ }))
    expect(screen.getByText(/# Add rate limiting to the webhook endpoint/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Hide hand-off prompt/ })).toBeInTheDocument()
  })

  it("opens the complete action list from a desktop row context menu", async () => {
    renderCard()

    fireEvent.contextMenu(screen.getByText("Add rate limiting to the webhook endpoint"))

    expect(await screen.findByRole("menuitem", { name: "Discuss in thread" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Copy prompt" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Mark done" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Cancel delegation" })).toBeInTheDocument()
  })

  it("restores focus to the overflow trigger after a desktop action", async () => {
    renderCard()
    const trigger = screen.getByRole("button", { name: "Card actions" })

    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole("menuitem", { name: "Show hand-off prompt" }))

    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("keeps the complete menu keyboard-accessible when touch hides its chrome", async () => {
    vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(true)
    vi.spyOn(hooksModule, "useInputMode").mockReturnValue("touch")
    renderCard()

    const trigger = screen.getByRole("button", { name: "Card actions" })
    expect(trigger.closest(".reveal-actions-hover-only")).not.toHaveClass("hidden")
    await userEvent.click(trigger)
    expect(screen.getByRole("menuitem", { name: "Mark done" })).toBeInTheDocument()
  })

  it("opens the mobile action drawer on card long press", () => {
    vi.useFakeTimers()
    vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(true)
    vi.spyOn(hooksModule, "useInputMode").mockReturnValue("touch")
    renderCard()

    const title = screen.getByText("Add rate limiting to the webhook endpoint")
    fireEvent.touchStart(title, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.getByRole("button", { name: "Mark done" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel delegation" })).toBeInTheDocument()
    vi.useRealTimers()
  })

  it("holding the persistent mobile Copy button does not open the row drawer", () => {
    vi.useFakeTimers()
    vi.spyOn(hooksModule, "useTouchCapable").mockReturnValue(true)
    vi.spyOn(hooksModule, "useInputMode").mockReturnValue("touch")
    renderCard()

    const copy = screen.getAllByRole("button", { name: "Copy prompt" })[0]
    fireEvent.touchStart(copy, { touches: [{ clientX: 10, clientY: 10 }] })
    act(() => vi.advanceTimersByTime(500))

    expect(screen.queryByRole("button", { name: "Mark done" })).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it("renders nothing without a payload", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/w/ws_1"]}>
        <PanelProvider>
          <DelegationEvent
            event={{ ...createdEvent(CREATED_PAYLOAD), payload: undefined }}
            workspaceId="ws_1"
            streamId="stream_1"
          />
        </PanelProvider>
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
