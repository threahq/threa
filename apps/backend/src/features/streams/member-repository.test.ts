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

describe("StreamMemberRepository.membersReadThrough", () => {
  test("returns an empty set without querying when memberIds is empty", async () => {
    const query = mock(() => Promise.resolve({ rows: [], rowCount: 0 }))
    const db = { query } as unknown as Querier
    expect(await StreamMemberRepository.membersReadThrough(db, "stream_1", [], 50n)).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  test("maps the returned rows to a set of member ids", async () => {
    const db = makeDb([{ member_id: "usr_caught" }, { member_id: "usr_also" }])
    const result = await StreamMemberRepository.membersReadThrough(
      db,
      "stream_1",
      ["usr_caught", "usr_also", "usr_behind"],
      50n
    )
    expect(result).toEqual(new Set(["usr_caught", "usr_also"]))
  })
})
