import { beforeEach, describe, expect, it } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import { useMemo } from "react"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real slot read path
import { db } from "@/db"
import { sharedMessageSlotKey, type SharedMessageSlot, type SlotMap } from "@threahq/types"
import { useStreamSlots } from "@/hooks/use-stream-slots"
import { SlotsProvider, useSharedMessageSlot } from "./context"

// Render read model (Amendment A3/A6): slots are seeded ONLY in db.slots — no
// TanStack carrier anywhere — and reach the consumer through the live
// `useStreamSlots` read + `SlotsProvider`. Mirrors stream-content's wiring,
// including the `{ ...parentSlots, ...currentSlots }` precedence.

function okSlot(messageId: string, contentMarkdown: string): SharedMessageSlot {
  return {
    type: "sharedMessage",
    state: "ok",
    messageId,
    streamId: "stream_src",
    authorId: "usr_1",
    authorType: "user",
    authorName: null,
    contentJson: { type: "doc", content: [] },
    contentMarkdown,
    editedAt: null,
    createdAt: "2026-04-23T10:00:00Z",
    attachments: [],
  }
}

function SlotConsumer({ messageId }: { messageId: string }) {
  const slot = useSharedMessageSlot(messageId)
  return <div data-testid={`slot-${messageId}`}>{slot && slot.state === "ok" ? slot.contentMarkdown : "empty"}</div>
}

function TimelineSlots({
  streamId,
  parentStreamId,
  messageIds,
}: {
  streamId: string
  parentStreamId?: string
  messageIds: string[]
}) {
  const currentSlots = useStreamSlots(streamId)
  const parentSlots = useStreamSlots(parentStreamId ?? null)
  const mergedSlots = useMemo<SlotMap>(() => ({ ...parentSlots, ...currentSlots }), [parentSlots, currentSlots])
  return (
    <SlotsProvider map={mergedSlots}>
      {messageIds.map((id) => (
        <SlotConsumer key={id} messageId={id} />
      ))}
    </SlotsProvider>
  )
}

async function seed(streamId: string, messageId: string, contentMarkdown: string) {
  await db.slots.put({
    workspaceId: "ws_1",
    streamId,
    slotKey: sharedMessageSlotKey(messageId),
    value: okSlot(messageId, contentMarkdown),
    _cachedAt: Date.now(),
  })
}

beforeEach(async () => {
  await db.slots.clear()
})

describe("slot render integration (real Dexie)", () => {
  it("renders a pointer card from db.slots alone and observes a live update", async () => {
    await seed("stream_current", "msg_1", "original")
    render(<TimelineSlots streamId="stream_current" messageIds={["msg_1"]} />)

    await waitFor(() => expect(screen.getByTestId("slot-msg_1")).toHaveTextContent("original"))

    // A socket/bootstrap write to db.slots re-renders the card in place.
    await act(() => seed("stream_current", "msg_1", "updated"))
    await waitFor(() => expect(screen.getByTestId("slot-msg_1")).toHaveTextContent("updated"))
  })

  it("current-stream rows override the parent fallback on a key collision", async () => {
    // The parent anchor's pointer and a current-stream pointer reference the
    // same source; current wins because the provider renders current events.
    await seed("stream_parent", "msg_shared", "from parent")
    await seed("stream_current", "msg_shared", "from current")

    render(<TimelineSlots streamId="stream_current" parentStreamId="stream_parent" messageIds={["msg_shared"]} />)

    await waitFor(() => expect(screen.getByTestId("slot-msg_shared")).toHaveTextContent("from current"))
  })

  it("falls back to the parent stream's slot for a pointer only the parent carries", async () => {
    await seed("stream_parent", "msg_parent_only", "parent content")

    render(<TimelineSlots streamId="stream_current" parentStreamId="stream_parent" messageIds={["msg_parent_only"]} />)

    await waitFor(() => expect(screen.getByTestId("slot-msg_parent_only")).toHaveTextContent("parent content"))
  })
})
