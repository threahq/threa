import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { DynamicNamingService } from "./service"
import { DynamicNamingStateRepository } from "./state-repository"
import type { DynamicNamingTargetAdapter } from "./types"

afterEach(() => mock.restore())

describe("DynamicNamingService.evaluate", () => {
  test("releases the owner's claim in the target's workspace when no user initiated the evaluation", async () => {
    const release = spyOn(DynamicNamingStateRepository, "releaseOwnedClaim").mockResolvedValue(1)
    const pool = {} as Pool
    const service = new DynamicNamingService(
      pool,
      new Map([["stream", {} as DynamicNamingTargetAdapter]]),
      {} as never,
      {} as never
    )

    const result = await service.evaluate(
      { workspaceId: "ws_1", targetKind: "stream", targetId: "stream_1" },
      "owner_1"
    )

    expect(result).toEqual({ status: "protected" })
    expect(release.mock.calls).toEqual([[pool, "ws_1", "owner_1"]])
  })
})
