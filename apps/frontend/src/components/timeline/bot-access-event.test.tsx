import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { BotAccessRequestedEventPayload, BotAccessStatusChangedEventPayload, StreamEvent } from "@threa/types"
import { toast } from "sonner"
import { botAccessApi } from "@/api"
import { BotAccessEvent } from "./bot-access-event"

beforeEach(() => {
  vi.restoreAllMocks()
})

function requestedEvent(payload: BotAccessRequestedEventPayload): StreamEvent {
  return {
    id: "evt_bar",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "bot_access:requested",
    actorId: "bot_runner",
    actorType: "bot",
    createdAt: new Date().toISOString(),
    payload,
  }
}

const REQUESTED_PAYLOAD: BotAccessRequestedEventPayload = {
  requestId: "bar_1",
  botId: "bot_1",
  botName: "Kris's Runner",
  delegationId: "dlg_1",
  delegationTitle: "Add rate limiting to the webhook endpoint",
  requestedByLabel: "Kris's MacBook",
}

function renderCard(opts?: { statusPatch?: BotAccessStatusChangedEventPayload; viewerIsMember?: boolean }) {
  return render(
    <BotAccessEvent
      event={requestedEvent(REQUESTED_PAYLOAD)}
      workspaceId="ws_1"
      statusPatch={opts?.statusPatch}
      viewerIsMember={opts?.viewerIsMember ?? true}
    />
  )
}

describe("BotAccessEvent", () => {
  it("renders the request from the payload snapshot: bot name, delegation title, requester", () => {
    renderCard()

    expect(screen.getByText("Kris's Runner")).toBeInTheDocument()
    expect(screen.getByText(/requests access to this stream/)).toBeInTheDocument()
    expect(screen.getByText(/To claim: Add rate limiting to the webhook endpoint · Kris's MacBook/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument()
  })

  it("approves via the API and flips to Access granted for the clicking member", async () => {
    const approve = vi.spyOn(botAccessApi, "approve").mockResolvedValue({ approved: true })
    const success = vi.spyOn(toast, "success")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))

    expect(approve).toHaveBeenCalledWith("ws_1", "bar_1")
    // Same element relabeled and aria-disabled, never unmounted — the clicker's
    // focus stays put. The Deny slot drops. INV-63: no success toast.
    const granted = await screen.findByRole("button", { name: /Access granted/ })
    expect(granted).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
  })

  it("denies via the API and flips to Denied for the clicking member", async () => {
    const deny = vi.spyOn(botAccessApi, "deny").mockResolvedValue({ denied: true })

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Deny" }))

    expect(deny).toHaveBeenCalledWith("ws_1", "bar_1")
    const denied = await screen.findByRole("button", { name: /Denied/ })
    expect(denied).toHaveAttribute("aria-disabled", "true")
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
  })

  it("does not flip when the approve lost the race — informs, waits for the authoritative patch", async () => {
    vi.spyOn(botAccessApi, "approve").mockResolvedValue({ approved: false })
    const info = vi.spyOn(toast, "info").mockImplementation(() => "")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(info).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Access granted/ })).not.toBeInTheDocument()
  })

  it("shows the failure toast when the approve call throws", async () => {
    vi.spyOn(botAccessApi, "approve").mockRejectedValue(new Error("boom"))
    const error = vi.spyOn(toast, "error").mockImplementation(() => "")

    renderCard()
    await userEvent.click(screen.getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument()
  })

  it("renders the authoritative approved patch as a terminal state, no action buttons", () => {
    renderCard({ statusPatch: { requestId: "bar_1", status: "approved" } })

    expect(screen.getByText(/Access granted/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument()
  })

  it("renders the authoritative denied patch as a terminal state", () => {
    renderCard({ statusPatch: { requestId: "bar_1", status: "denied" } })

    expect(screen.getByText(/Denied/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
  })

  it("non-member sees the card but no Approve/Deny buttons", () => {
    renderCard({ viewerIsMember: false })

    expect(screen.getByText("Kris's Runner")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Deny" })).not.toBeInTheDocument()
  })

  it("non-member still sees the terminal status text", () => {
    renderCard({ viewerIsMember: false, statusPatch: { requestId: "bar_1", status: "approved" } })

    expect(screen.getByText(/Access granted/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument()
  })

  it("omits the context line when no delegation or requester is attached", () => {
    render(
      <BotAccessEvent
        event={requestedEvent({ requestId: "bar_2", botId: "bot_2", botName: "Bare Bot" })}
        workspaceId="ws_1"
        viewerIsMember
      />
    )

    expect(screen.getByText("Bare Bot")).toBeInTheDocument()
    expect(screen.queryByText(/To claim:/)).not.toBeInTheDocument()
  })

  it("renders nothing without a payload", () => {
    const { container } = render(
      <BotAccessEvent
        event={{ ...requestedEvent(REQUESTED_PAYLOAD), payload: undefined }}
        workspaceId="ws_1"
        viewerIsMember
      />
    )
    expect(container).toBeEmptyDOMElement()
  })
})
