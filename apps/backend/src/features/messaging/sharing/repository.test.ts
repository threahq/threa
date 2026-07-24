import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as streams from "../../streams"
import { SharedMessageRepository } from "./repository"

afterEach(() => mock.restore())

describe("SharedMessageRepository.listSourcesGrantedToRoom", () => {
  it("keeps grants targeting the room or a public-resolving stream", async () => {
    const db = {
      query: mock(async () => ({
        rows: [
          { source_message_id: "msg_room", target_stream_id: "stream_room" },
          { source_message_id: "msg_public", target_stream_id: "stream_public" },
          { source_message_id: "msg_private", target_stream_id: "stream_private" },
        ],
      })),
    }
    spyOn(streams, "listRoomReadableStreamIds").mockResolvedValue(new Set(["stream_room", "stream_public"]))

    const result = await SharedMessageRepository.listSourcesGrantedToRoom(db as any, "ws_1", "stream_room", [
      "msg_room",
      "msg_public",
      "msg_private",
    ])

    expect(result).toEqual(new Set(["msg_room", "msg_public"]))
  })
})

describe("SharedMessageRepository.listSourcesGrantedToAnyStream", () => {
  it("keeps sources granted into any stream in the caller's accessible set", async () => {
    const db = {
      query: mock(async () => ({
        rows: [
          { source_message_id: "msg_in", target_stream_id: "stream_readable" },
          { source_message_id: "msg_out", target_stream_id: "stream_other" },
          { source_message_id: "msg_in", target_stream_id: "stream_readable_2" },
        ],
      })),
    }

    const result = await SharedMessageRepository.listSourcesGrantedToAnyStream(
      db as any,
      "ws_1",
      new Set(["stream_readable", "stream_readable_2"]),
      ["msg_in", "msg_out"]
    )

    expect(result).toEqual(new Set(["msg_in"]))
  })

  it("short-circuits without a query when there are no sources or no readable streams", async () => {
    const db = { query: mock(async () => ({ rows: [] })) }
    expect(await SharedMessageRepository.listSourcesGrantedToAnyStream(db as any, "ws_1", new Set(["s"]), [])).toEqual(
      new Set()
    )
    expect(
      await SharedMessageRepository.listSourcesGrantedToAnyStream(db as any, "ws_1", new Set(), ["msg_a"])
    ).toEqual(new Set())
    expect(db.query).not.toHaveBeenCalled()
  })
})
