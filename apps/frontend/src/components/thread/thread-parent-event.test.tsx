import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { StreamEvent } from "@threahq/types"
import * as messageEventModule from "@/components/timeline/message-event"
import * as delegationEventModule from "@/components/timeline/delegation-event"
import { ThreadParentEvent } from "./thread-parent-event"

// Leaf renderers pull heavy provider trees; the anchor-agnostic behavior under
// test is that ThreadParentEvent dispatches the anchor through EventItem by its
// type — messages as messages, cards as cards — so scope the leaves (INV-48).
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(messageEventModule, "MessageEvent").mockImplementation((({
    event,
    isThreadParent,
  }: Parameters<typeof messageEventModule.MessageEvent>[0]) => (
    <div data-testid="message-event" data-thread-parent={String(isThreadParent)}>
      {(event.payload as { contentMarkdown: string }).contentMarkdown}
    </div>
  )) as unknown as typeof messageEventModule.MessageEvent)
  vi.spyOn(delegationEventModule, "DelegationEvent").mockImplementation((({
    event,
  }: Parameters<typeof delegationEventModule.DelegationEvent>[0]) => (
    <div data-testid="delegation-event">{(event.payload as { delegationId: string }).delegationId}</div>
  )) as unknown as typeof delegationEventModule.DelegationEvent)
})

const workspaceId = "ws_1"
const parentStreamId = "stream_parent"

const messageAnchor: StreamEvent = {
  id: "event_1",
  streamId: parentStreamId,
  sequence: "1",
  eventType: "message_created",
  actorType: "user",
  actorId: "usr_1",
  createdAt: new Date().toISOString(),
  payload: { messageId: "msg_anchor", contentMarkdown: "Anchor message body" },
}

const delegationCardAnchor: StreamEvent = {
  id: "event_dlg",
  streamId: parentStreamId,
  sequence: "2",
  eventType: "delegation:created",
  actorType: "user",
  actorId: "usr_1",
  createdAt: new Date().toISOString(),
  payload: { delegationId: "dlg_1", title: "Do the thing" },
}

describe("ThreadParentEvent", () => {
  it("renders a message anchor through the message renderer, as a thread parent", () => {
    render(
      <ThreadParentEvent event={messageAnchor} workspaceId={workspaceId} streamId={parentStreamId} replyCount={3} />
    )
    const rendered = screen.getByTestId("message-event")
    expect(rendered).toHaveTextContent("Anchor message body")
    // isThreadParent suppresses the message row's own ThreadSlot (no recursion).
    expect(rendered).toHaveAttribute("data-thread-parent", "true")
    expect(screen.getByText("3 replies")).toBeInTheDocument()
    expect(screen.queryByTestId("delegation-event")).not.toBeInTheDocument()
  })

  it("renders a delegation:created card anchor through the card renderer", () => {
    render(
      <ThreadParentEvent
        event={delegationCardAnchor}
        workspaceId={workspaceId}
        streamId={parentStreamId}
        replyCount={1}
      />
    )
    expect(screen.getByTestId("delegation-event")).toHaveTextContent("dlg_1")
    // The reply bar singularizes and the card carries no message renderer.
    expect(screen.getByText("1 reply")).toBeInTheDocument()
    expect(screen.queryByTestId("message-event")).not.toBeInTheDocument()
  })
})
