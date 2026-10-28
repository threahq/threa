import { describe, expect, mock, test } from "bun:test"
import { AuthorTypes } from "@threahq/types"
import type { OutboxEvent } from "../../lib/outbox"
import { JobQueues } from "../../lib/queue"
import { DocActivityOutboxHandler } from "./activity-outbox-handler"
import { DOC_ACTIVITY_QUIET_MS } from "./config"

class TestHandler extends DocActivityOutboxHandler {
  processAll(events: OutboxEvent[]) {
    return this.processBatch(events)
  }
}

const windowStart = Math.floor(Date.parse("2026-10-26T12:00:00.000Z") / DOC_ACTIVITY_QUIET_MS) * DOC_ACTIVITY_QUIET_MS
const bucket = windowStart / DOC_ACTIVITY_QUIET_MS

function docUpdated(id: bigint, docId: string, atMs: number, actorType: string = AuthorTypes.USER): OutboxEvent {
  return {
    id,
    eventType: "doc:updated",
    payload: {
      workspaceId: "ws_1",
      streamId: docId,
      seq: Number(id),
      update: "AA==",
      touchedBlockIds: [],
      actorId: actorType === AuthorTypes.SYSTEM ? AuthorTypes.SYSTEM : "usr_1",
      actorType,
    },
    createdAt: new Date(windowStart + atMs),
  } as unknown as OutboxEvent
}

describe("DocActivityOutboxHandler", () => {
  test("should send one roll-up per doc per quiet window when flushes burst, ignoring system flushes", async () => {
    const send = mock(async (..._args: unknown[]) => "queued")
    const handler = new TestHandler({} as never, { send })

    const seen = await handler.processAll([
      docUpdated(1n, "stream_a", 1_000),
      docUpdated(2n, "stream_a", 4_000),
      docUpdated(3n, "stream_a", 4_000, AuthorTypes.SYSTEM),
      docUpdated(4n, "stream_b", 2_000),
      docUpdated(5n, "stream_a", DOC_ACTIVITY_QUIET_MS + 500),
      docUpdated(6n, "stream_c", 3_000, AuthorTypes.SYSTEM),
    ])

    expect({ seen, calls: send.mock.calls }).toEqual({
      seen: [1n, 2n, 3n, 4n, 5n, 6n],
      calls: [
        [
          JobQueues.DOC_ACTIVITY_ROLLUP,
          { workspaceId: "ws_1", docId: "stream_a" },
          {
            processAfter: new Date(windowStart + 4_000 + DOC_ACTIVITY_QUIET_MS),
            messageId: `doc-activity:stream_a:${bucket}`,
          },
        ],
        [
          JobQueues.DOC_ACTIVITY_ROLLUP,
          { workspaceId: "ws_1", docId: "stream_b" },
          {
            processAfter: new Date(windowStart + 2_000 + DOC_ACTIVITY_QUIET_MS),
            messageId: `doc-activity:stream_b:${bucket}`,
          },
        ],
        [
          JobQueues.DOC_ACTIVITY_ROLLUP,
          { workspaceId: "ws_1", docId: "stream_a" },
          {
            processAfter: new Date(windowStart + 2 * DOC_ACTIVITY_QUIET_MS + 500),
            messageId: `doc-activity:stream_a:${bucket + 1}`,
          },
        ],
      ],
    })
  })
})
