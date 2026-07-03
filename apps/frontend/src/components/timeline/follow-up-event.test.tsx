import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import type { AgentFollowUpScheduledEventPayload, AgentFollowUpCancelledEventPayload, StreamEvent } from "@threa/types"
import * as hooksModule from "@/hooks"
import { agentFollowUpsApi } from "@/api"
import { FollowUpScheduledEvent, FollowUpCancelledEvent } from "./follow-up-event"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(hooksModule, "useActors").mockReturnValue({
    getActorName: () => "Ariadne",
  } as unknown as ReturnType<typeof hooksModule.useActors>)
})

function scheduledEvent(payload: AgentFollowUpScheduledEventPayload): StreamEvent {
  return {
    id: "evt_sched",
    streamId: "stream_1",
    sequence: "20",
    broadcastSequence: "12",
    eventType: "agent:follow_up_scheduled",
    actorId: "persona_system_ariadne",
    actorType: "persona",
    createdAt: new Date().toISOString(),
    payload,
  }
}

function cancelledEvent(payload: AgentFollowUpCancelledEventPayload): StreamEvent {
  return {
    id: "evt_cancel",
    streamId: "stream_1",
    sequence: "21",
    broadcastSequence: "13",
    eventType: "agent:follow_up_cancelled",
    actorId: "usr_kris",
    actorType: "user",
    createdAt: new Date().toISOString(),
    payload,
  }
}

const SCHEDULED_PAYLOAD: AgentFollowUpScheduledEventPayload = {
  followUpId: "agfu_1",
  note: "check the deploy went green",
  scheduledFor: "2026-07-03T12:00:00.000Z",
  sourceConversationId: null,
}

describe("FollowUpScheduledEvent", () => {
  it("renders the actor, note, fire time, and a Cancel button", () => {
    render(
      <MemoryRouter>
        <FollowUpScheduledEvent event={scheduledEvent(SCHEDULED_PAYLOAD)} workspaceId="ws_1" />
      </MemoryRouter>
    )

    expect(screen.getByText(/Ariadne scheduled a follow-up/)).toBeInTheDocument()
    expect(screen.getByText("check the deploy went green")).toBeInTheDocument()
    expect(screen.getByText(/2026/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
  })

  it("cancels via the API and flips the card to a muted Cancelled state (INV-63: no success toast)", async () => {
    const cancel = vi.spyOn(agentFollowUpsApi, "cancel").mockResolvedValue({ cancelled: true })

    render(
      <MemoryRouter>
        <FollowUpScheduledEvent event={scheduledEvent(SCHEDULED_PAYLOAD)} workspaceId="ws_1" />
      </MemoryRouter>
    )

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(cancel).toHaveBeenCalledWith("ws_1", "agfu_1")
    await waitFor(() => expect(screen.getByText("Cancelled")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
  })

  it("renders nothing without a payload", () => {
    const { container } = render(
      <MemoryRouter>
        <FollowUpScheduledEvent
          event={{ ...scheduledEvent(SCHEDULED_PAYLOAD), payload: undefined }}
          workspaceId="ws_1"
        />
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe("FollowUpCancelledEvent", () => {
  it("attributes the cancellation and shows the struck-through note", () => {
    render(
      <MemoryRouter>
        <FollowUpCancelledEvent
          event={cancelledEvent({
            followUpId: "agfu_1",
            note: "check the deploy went green",
            scheduledFor: "2026-07-03T12:00:00.000Z",
          })}
          workspaceId="ws_1"
        />
      </MemoryRouter>
    )

    expect(screen.getByText(/Ariadne cancelled a scheduled follow-up/)).toBeInTheDocument()
    expect(screen.getByText("check the deploy went green")).toBeInTheDocument()
  })
})
