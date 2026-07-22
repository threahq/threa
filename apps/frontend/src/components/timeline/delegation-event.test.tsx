import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { DelegationCreatedEventPayload, DelegationStatusChangedEventPayload, StreamEvent } from "@threa/types"
import { toast } from "sonner"
import * as hooksModule from "@/hooks"
import { PanelProvider } from "@/contexts"
import { delegationsApi } from "@/api"
import { buildDelegationPrompt, DelegationEvent } from "./delegation-event"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ariadne",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
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
  it("renders the open state: title, actor · status meta, Copy prompt, and Cancel", () => {
    renderCard()

    expect(screen.getByText("Add rate limiting to the webhook endpoint")).toBeInTheDocument()
    expect(screen.getByText(/Ariadne · Open/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Copy prompt/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "View result" })).not.toBeInTheDocument()
  })

  it("advances with the authoritative status patch: claimed shows the claimer label", () => {
    renderCard({ delegationId: "dlg_1", status: "claimed", claimedByLabel: "Kris's MacBook / Claude Code" })

    expect(screen.getByText(/Ariadne · Claimed · Kris's MacBook \/ Claude Code/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("shows the running progress note", () => {
    renderCard({ delegationId: "dlg_1", status: "running", statusNote: "tests are compiling" })

    expect(screen.getByText(/Ariadne · Running/)).toBeInTheDocument()
    expect(screen.getByText("tests are compiling")).toBeInTheDocument()
  })

  it("completed with threadStreamId: chip + View result reach the thread, no Discuss duplicate", () => {
    renderCard(
      {
        delegationId: "dlg_1",
        status: "completed",
        resultMessageId: "msg_result",
        threadStreamId: "stream_thread",
      },
      { threadId: "stream_thread", replyCount: 3 }
    )

    const link = screen.getByRole("link", { name: "View result" })
    expect(link).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
    const chip = screen.getByRole("link", { name: /replies/ })
    expect(chip).toHaveTextContent("3 replies")
    expect(chip).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Discuss this delegation" })).not.toBeInTheDocument()
  })

  it("completed thread parent suppresses self-links and nested thread affordances", () => {
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

    expect(screen.queryByRole("link", { name: "View result" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /replies/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Discuss this delegation" })).not.toBeInTheDocument()
    expect(screen.getByText("Add rate limiting to the webhook endpoint")).toBeInTheDocument()
  })

  it("completed (legacy shape): no threadStreamId falls back to the ?m= result deep-link", () => {
    renderCard({ delegationId: "dlg_1", status: "completed", resultMessageId: "msg_result" })

    const link = screen.getByRole("link", { name: "View result" })
    expect(link).toHaveAttribute("href", "/w/ws_1/s/stream_1?m=msg_result")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("open card: Discuss opens a draft thread panel keyed on the card's event id", () => {
    renderCard()

    const discuss = screen.getByRole("link", { name: "Discuss this delegation" })
    expect(discuss).toHaveAttribute("href", "/w/ws_1?panel=draft%3Astream_1%3Aevt_dlg")
  })

  it("renders the thread chip from the healed payload (replies land on the card's own event)", () => {
    renderCard(undefined, { threadId: "stream_thread", replyCount: 2 })

    const chip = screen.getByRole("link", { name: /replies/ })
    expect(chip).toHaveTextContent("2 replies")
    expect(chip).toHaveAttribute("href", "/w/ws_1?panel=stream_thread")
  })

  it.each(["failed", "expired"] as const)("%s is terminal: no Cancel, status in meta", (status) => {
    renderCard({ delegationId: "dlg_1", status })

    expect(screen.getByText(new RegExp(`Ariadne · ${status}`, "i"))).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Cancel/ })).not.toBeInTheDocument()
  })

  it.each(["failed", "cancelled", "expired"] as const)(
    "%s card is discussion-worthy: Discuss stays available when there's no thread yet",
    (status) => {
      renderCard({ delegationId: "dlg_1", status })

      const discuss = screen.getByRole("link", { name: "Discuss this delegation" })
      expect(discuss).toHaveAttribute("href", "/w/ws_1?panel=draft%3Astream_1%3Aevt_dlg")
    }
  )

  it("cancelled keeps the relabeled button in place (follow-up card pattern: focus retained, announced)", () => {
    renderCard({ delegationId: "dlg_1", status: "cancelled" })

    const button = screen.getByRole("button", { name: "Cancelled" })
    expect(button).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("copies the compiled prompt and confirms in place with a checkmark (INV-63/21: no toast, same footprint)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const success = vi.spyOn(toast, "success")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: /Copy prompt/ }))

    expect(writeText).toHaveBeenCalledWith(
      buildDelegationPrompt(CREATED_PAYLOAD, { workspaceId: "ws_1", origin: window.location.origin })
    )
    await screen.findByRole("button", { name: "Prompt copied" })
    expect(success).not.toHaveBeenCalled()
  })

  it("copies a shareable delegation link and confirms in place with a checkmark (INV-63/21: no toast)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const success = vi.spyOn(toast, "success")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: /Copy link/ }))

    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/w/ws_1/delegations/dlg_1`)
    await screen.findByRole("button", { name: "Link copied" })
    expect(success).not.toHaveBeenCalled()
  })

  it("marks the delegation done for paste-path work and relabels in place", async () => {
    const markDone = vi.spyOn(delegationsApi, "markDone").mockResolvedValue({ completed: true })

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }))

    expect(markDone).toHaveBeenCalledWith("ws_1", "dlg_1")
    await waitFor(() => expect(screen.getByText(/Ariadne · Completed/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: /Done/ })).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("does not flip when mark-done lost the race; informs instead", async () => {
    vi.spyOn(delegationsApi, "markDone").mockResolvedValue({ completed: false })
    const info = vi.spyOn(toast, "info")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Mark done" }))

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
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(cancel).toHaveBeenCalledWith("ws_1", "dlg_1")
    await waitFor(() => expect(screen.getByText(/Ariadne · Cancelled/)).toBeInTheDocument())
    // Same element throughout — relabeled and aria-disabled, never unmounted,
    // so the clicker's focus doesn't drop to <body>.
    expect(screen.getByRole("button", { name: "Cancelled" })).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("does not flip when the cancel lost the race — the authoritative patch will land", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")
    vi.spyOn(delegationsApi, "cancel").mockResolvedValue({ cancelled: false })

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() => expect(info).toHaveBeenCalled())
    expect(screen.getByText(/Ariadne · Open/)).toBeInTheDocument()
  })

  it("expands the hand-off prompt inline as source text", async () => {
    renderCard()

    await userEvent.click(screen.getByRole("button", { name: /Show hand-off prompt/ }))
    expect(screen.getByText(/# Add rate limiting to the webhook endpoint/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Hide hand-off prompt/ })).toBeInTheDocument()
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
