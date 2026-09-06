import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { SystemEvent } from "./system-event"
import type { StreamEvent } from "@threahq/types"

const makeEvent = (eventType: StreamEvent["eventType"]): StreamEvent => ({
  id: `event_${eventType}`,
  streamId: "stream_123",
  sequence: "1",
  eventType,
  actorType: "user",
  actorId: "member_123",
  createdAt: new Date().toISOString(),
  payload: {},
})

describe("SystemEvent", () => {
  it("renders a thread-creation notice", () => {
    render(<SystemEvent event={makeEvent("thread_created")} />)
    expect(screen.getByText("A thread was started")).toBeInTheDocument()
  })

  // Archive/unarchive events render on the archived stream's own timeline — the
  // root the user archived, which is a scratchpad or channel, not a thread. The
  // copy must stay stream-type-neutral so it never mislabels a channel as a thread.
  it("describes archive with stream-neutral copy", () => {
    render(<SystemEvent event={makeEvent("stream_archived")} />)
    const text = screen.getByText(/sealed in the labyrinth/i)
    expect(text).toBeInTheDocument()
    expect(text.textContent).not.toMatch(/thread/i)
  })

  it("describes unarchive with stream-neutral copy", () => {
    render(<SystemEvent event={makeEvent("stream_unarchived")} />)
    const text = screen.getByText(/restored from the labyrinth/i)
    expect(text).toBeInTheDocument()
    expect(text.textContent).not.toMatch(/thread/i)
  })
})
