import { describe, expect, test } from "bun:test"
import { sql } from "squid/pg"
import { composeSql } from "./compose"

describe("composeSql", () => {
  test("plain values only behave exactly like sql``", () => {
    const query = composeSql`SELECT * FROM users WHERE id = ${"u_1"} AND age > ${30}`
    expect(query).toEqual({
      text: "SELECT * FROM users WHERE id = $1 AND age > $2",
      values: ["u_1", 30],
    })
  })

  test("no interpolations returns the static text with empty values", () => {
    const query = composeSql`SELECT 1`
    expect(query).toEqual({ text: "SELECT 1", values: [] })
  })

  test("splices a single fragment inline and merges its values", () => {
    const fragment = sql`status = ${"active"} AND deleted_at IS NULL`
    const query = composeSql`SELECT * FROM streams WHERE workspace_id = ${"ws_1"} AND (${fragment})`
    expect(query).toEqual({
      text: "SELECT * FROM streams WHERE workspace_id = $1 AND (status = $2 AND deleted_at IS NULL)",
      values: ["ws_1", "active"],
    })
  })

  test("renumbers multiple fragments so placeholders never collide", () => {
    // Both fragments use $1 internally; composing must renumber each to a
    // distinct outer placeholder.
    const first = sql`a = ${"A"}`
    const second = sql`b = ${"B"}`
    const query = composeSql`WHERE ${first} OR ${second} OR c = ${"C"}`
    expect(query).toEqual({
      text: "WHERE a = $1 OR b = $2 OR c = $3",
      values: ["A", "B", "C"],
    })
  })

  test("renumbers a fragment that holds multiple placeholders, including multi-digit offsets", () => {
    // Outer query first emits 9 plain values, then a fragment whose own
    // placeholders are $1 and $2 — they must shift to $10 and $11.
    const fragment = sql`x = ${"X"} AND y = ${"Y"}`
    const query = composeSql`SELECT ${1}, ${2}, ${3}, ${4}, ${5}, ${6}, ${7}, ${8}, ${9} WHERE ${fragment}`
    expect(query).toEqual({
      text: "SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 WHERE x = $10 AND y = $11",
      values: [1, 2, 3, 4, 5, 6, 7, 8, 9, "X", "Y"],
    })
  })

  test("handles a fragment with no values (raw-only)", () => {
    const fragment = sql`s.archived_at IS NULL`
    const query = composeSql`SELECT * FROM streams WHERE workspace_id = ${"ws_1"} AND ${fragment} AND id = ${"s_1"}`
    expect(query).toEqual({
      text: "SELECT * FROM streams WHERE workspace_id = $1 AND s.archived_at IS NULL AND id = $2",
      values: ["ws_1", "s_1"],
    })
  })

  test("handles fragments adjacent to plain values on both sides", () => {
    const fragment = sql`role = ${"admin"}`
    const query = composeSql`WHERE w = ${"ws"} AND ${fragment} AND tier = ${"gold"}`
    expect(query).toEqual({
      text: "WHERE w = $1 AND role = $2 AND tier = $3",
      values: ["ws", "admin", "gold"],
    })
  })

  test("preserves parameter ordering when a fragment precedes plain values", () => {
    const predicate = sql`(visibility = ${"public"} OR owner = ${"u_1"})`
    const query = composeSql`SELECT id FROM s WHERE ${predicate} AND workspace_id = ${"ws_1"}`
    expect(query).toEqual({
      text: "SELECT id FROM s WHERE (visibility = $1 OR owner = $2) AND workspace_id = $3",
      values: ["public", "u_1", "ws_1"],
    })
  })

  test("a composed fragment can itself be re-composed (nested composition)", () => {
    // composeSql output is QueryConfig-shaped, so it splices into another
    // composeSql call exactly like a squid fragment does.
    const inner = composeSql`id = ${"s_1"}`
    const outer = composeSql`SELECT 1 WHERE ws = ${"ws_1"} AND ${inner} AND tier = ${"gold"}`
    expect(outer).toEqual({
      text: "SELECT 1 WHERE ws = $1 AND id = $2 AND tier = $3",
      values: ["ws_1", "s_1", "gold"],
    })
  })
})
