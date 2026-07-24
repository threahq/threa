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
