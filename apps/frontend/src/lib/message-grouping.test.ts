import { describe, it, expect } from "vitest"
import type { StreamEvent } from "@threahq/types"
import { AUTHOR_RUN_WINDOW_MS, isContinuation, isSameAuthorRun } from "./message-grouping"
import { annotateAuthorGroups, type TimelineItem } from "@/components/timeline/event-list"
import { type RenderableMessage } from "@/components/message/message-item"

const BASE = Date.parse("2026-07-30T10:00:00.000Z")

interface Row {
  id: string
  authorId: string
  authorType: "user" | "persona"
  offsetMs: number
  deleted?: boolean
}

const SEQUENCE: Row[] = [
  { id: "m1", authorId: "usr_1", authorType: "user", offsetMs: 0 },
  { id: "m2", authorId: "usr_1", authorType: "user", offsetMs: 1_000 },
  // Author change.
  { id: "m3", authorId: "usr_2", authorType: "user", offsetMs: 2_000 },
  // Same id, different actor type.
  { id: "m4", authorId: "usr_2", authorType: "persona", offsetMs: 3_000 },
  { id: "m5", authorId: "usr_2", authorType: "persona", offsetMs: 4_000 },
  // Beyond the window.
  { id: "m6", authorId: "usr_2", authorType: "persona", offsetMs: 4_000 + AUTHOR_RUN_WINDOW_MS + 1 },
  // A tombstone breaks the run on both surfaces.
  { id: "m7", authorId: "usr_2", authorType: "persona", offsetMs: 4_000 + AUTHOR_RUN_WINDOW_MS + 2, deleted: true },
  { id: "m8", authorId: "usr_2", authorType: "persona", offsetMs: 4_000 + AUTHOR_RUN_WINDOW_MS + 3 },
]

function asMessage(row: Row): RenderableMessage {
  return {
    id: row.id,
    authorId: row.authorId,
    authorType: row.authorType,
    contentMarkdown: row.id,
    reactions: {},
    createdAt: new Date(BASE + row.offsetMs).toISOString(),
    deletedAt: row.deleted ? new Date(BASE + row.offsetMs).toISOString() : null,
  }
}

function asTimelineItem(row: Row): TimelineItem {
  const event = {
    id: `evt_${row.id}`,
    streamId: "stream_1",
    sequence: "1",
    eventType: "message_created",
    actorId: row.authorId,
    actorType: row.authorType,
    payload: { messageId: row.id, ...(row.deleted ? { deletedAt: new Date(BASE + row.offsetMs).toISOString() } : {}) },
    createdAt: new Date(BASE + row.offsetMs).toISOString(),
  } as unknown as StreamEvent
  return { type: "event", event }
}

/** Run heads: the ids that start a run on each surface. */
function messageItemHeads(rows: Row[]): string[] {
  const messages = rows.map(asMessage)
  return messages
    .filter((message, index) => index === 0 || !isContinuation(messages[index - 1], message))
    .map((m) => m.id)
}

function eventListHeads(rows: Row[]): string[] {
  return annotateAuthorGroups(rows.map(asTimelineItem))
    .filter((item) => item.type === "event" && !("groupContinuation" in item && item.groupContinuation))
    .map((item) => (item.type === "event" ? ((item.event.payload as { messageId: string }).messageId ?? "") : ""))
}

describe("isSameAuthorRun", () => {
  it("gives both consumers the same run boundaries across author, type, gap and tombstone breaks", () => {
    const expected = ["m1", "m3", "m4", "m6", "m7", "m8"]
    expect({ messageItem: messageItemHeads(SEQUENCE), eventList: eventListHeads(SEQUENCE) }).toEqual({
      messageItem: expected,
      eventList: expected,
    })
  })

  it("groups at exactly the window inclusively, and exclusively when the caller asks", () => {
    const prev = { authorId: "usr_1", authorType: "user", createdAtMs: BASE }
    const next = { authorId: "usr_1", authorType: "user", createdAtMs: BASE + AUTHOR_RUN_WINDOW_MS }
    expect({
      inclusive: isSameAuthorRun(prev, next),
      exclusive: isSameAuthorRun(prev, next, { boundary: "exclusive" }),
    }).toEqual({ inclusive: true, exclusive: false })
  })

  it("treats two null actor ids as the same author (system rows)", () => {
    const prev = { authorId: null, authorType: null, createdAtMs: BASE }
    const next = { authorId: null, authorType: null, createdAtMs: BASE + 1 }
    expect(isSameAuthorRun(prev, next)).toBe(true)
  })

  it("never groups a row that breaks the run", () => {
    const prev = { authorId: "usr_1", authorType: "user", createdAtMs: BASE }
    expect(isSameAuthorRun(prev, { ...prev, createdAtMs: BASE + 1, breaksRun: true })).toBe(false)
  })
})
