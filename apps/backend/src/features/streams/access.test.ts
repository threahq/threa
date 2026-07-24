import { describe, expect, it, mock } from "bun:test"
import type { QueryConfig } from "pg"
import { Visibilities } from "@threa/types"
import { listRoomReadableStreamIds } from "./access"

describe("listRoomReadableStreamIds", () => {
  it("returns no ids without querying for empty input", async () => {
    const query = mock(async () => ({ rows: [] }))
    expect(await listRoomReadableStreamIds({ query } as any, "ws_1", "stream_room", [])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  it("pins the room-readable SQL: thread→root join, room-or-public predicate, workspace and candidate filters", async () => {
    let captured: QueryConfig | null = null
    const query = mock(async (q: QueryConfig) => {
      captured = q
      return { rows: [{ id: "stream_room" }, { id: "stream_public" }, { id: "thread_public" }] }
    })

    const result = await listRoomReadableStreamIds({ query } as any, "ws_1", "stream_room", [
      "stream_room",
      "stream_public",
      "stream_private",
      "thread_public",
      "thread_private",
      "stream_missing",
    ])

    // Thread → root resolution shares the per-viewer predicate's rule (INV-62).
    expect(captured!.text).toContain("JOIN streams root ON root.id = COALESCE(s.root_stream_id, s.id)")
    expect(captured!.text).toContain("s.workspace_id = $1")
    expect(captured!.text).toContain("s.id = ANY($2)")
    expect(captured!.text).toContain("s.id = $3 OR root.visibility = $4")
    expect(captured!.values).toEqual([
      "ws_1",
      ["stream_room", "stream_public", "stream_private", "thread_public", "thread_private", "stream_missing"],
      "stream_room",
      Visibilities.PUBLIC,
    ])
    expect(result).toEqual(new Set(["stream_room", "stream_public", "thread_public"]))
  })
})
