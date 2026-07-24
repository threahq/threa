import { describe, expect, test, mock } from "bun:test"
import { StreamMemberRepository } from "./member-repository"
import type { Querier } from "../../db"

function makeDb(rows: Record<string, unknown>[]) {
  const query = mock(() => Promise.resolve({ rows, rowCount: rows.length }))
  return { query } as unknown as Querier
}

describe("StreamMemberRepository.countMembersNotIn", () => {
  test("returns the parsed count when the query yields a row", async () => {
    const db = makeDb([{ count: "3" }])
    expect(await StreamMemberRepository.countMembersNotIn(db, "stream_target", "stream_source")).toBe(3)
  })

  test("returns 0 when the query yields no rows", async () => {
    const db = makeDb([])
    expect(await StreamMemberRepository.countMembersNotIn(db, "stream_target", "stream_source")).toBe(0)
  })
})
