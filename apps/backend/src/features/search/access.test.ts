import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Querier } from "../../db"
import { resolveUserAccessibleStreamIds } from "./access"
import { SearchRepository } from "./repository"

describe("resolveUserAccessibleStreamIds", () => {
  afterEach(() => mock.restore())

  it("should resolve the user's accessible streams within the caller's workspace", async () => {
    const accessible = spyOn(SearchRepository, "getAccessibleStreamsWithMembers").mockResolvedValue(["stream_1"])
    const db = {} as Querier

    const streams = await resolveUserAccessibleStreamIds(db, "ws_1", "usr_1", { userIds: ["usr_2"] })

    expect({ streams, calls: accessible.mock.calls }).toEqual({
      streams: ["stream_1"],
      calls: [[db, { workspaceId: "ws_1", userId: "usr_1", userIds: ["usr_2"] }]],
    })
  })
})
