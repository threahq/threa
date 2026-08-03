import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { StreamEventRepository } from "../streams"
import { insertCommandDispatchedEvent } from "./events"

const insertedEvent = {
  id: "evt_1",
  streamId: "stream_1",
  sequence: 1n,
  broadcastSequence: null,
  eventType: "command_dispatched" as const,
  payload: {},
  actorId: "usr_1",
  actorType: "user" as const,
  createdAt: new Date("2026-07-28T10:00:00.000Z"),
}

function baseParams() {
  return {
    workspaceId: "ws_1",
    streamId: "stream_1",
    userId: "usr_1",
    commandId: "cmd_1",
    name: "compact",
    args: "",
  }
}

describe("insertCommandDispatchedEvent conversation ref", () => {
  afterEach(() => {
    mock.restore()
  })

  it("stamps the dispatching conversation on the payload", async () => {
    const insert = spyOn(StreamEventRepository, "insert").mockResolvedValue(insertedEvent)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    await insertCommandDispatchedEvent({} as Querier, { ...baseParams(), conversationId: "conv_1" })

    expect(insert.mock.calls[0][1].payload).toEqual({
      commandId: "cmd_1",
      name: "compact",
      args: "",
      status: "dispatched",
      conversationId: "conv_1",
    })
  })

  it("omits the field for a stream-level dispatch", async () => {
    const insert = spyOn(StreamEventRepository, "insert").mockResolvedValue(insertedEvent)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as never)

    await insertCommandDispatchedEvent({} as Querier, baseParams())

    expect(insert.mock.calls[0][1].payload).toEqual({
      commandId: "cmd_1",
      name: "compact",
      args: "",
      status: "dispatched",
    })
  })
})
