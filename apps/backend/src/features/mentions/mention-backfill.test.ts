import { describe, expect, it } from "bun:test"
import type { JSONContent, MentionActorType } from "@threa/types"
import { chunkIds, resolveContentRows } from "./mention-backfill"
import type { MentionResolutionMaps } from "./resolution"

const mention = (id: string, slug: string, mentionType: string): JSONContent => ({
  type: "mention",
  attrs: { id, slug, mentionType },
})

const doc = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
})

const maps = (mention?: Array<[string, { id: string; actorType: MentionActorType }]>): MentionResolutionMaps => ({
  mentionSlugToActor: new Map(mention ?? []),
  channelSlugToStreamId: new Map(),
})

describe("chunkIds", () => {
  it("slices ids into fixed-size chunks with a trailing remainder", () => {
    const ids = Array.from({ length: 1101 }, (_, i) => `id_${i}`)
    const chunks = chunkIds(ids, 500)

    expect(chunks.map((c) => c.length)).toEqual([500, 500, 101])
    expect(chunks[0][0]).toBe("id_0")
    expect(chunks[2][100]).toBe("id_1100")
  })

  it("returns no chunks for an empty id list", () => {
    expect(chunkIds([], 500)).toEqual([])
  })
})

describe("resolveContentRows", () => {
  it("returns only rows whose content changed, carrying the rewritten contentJson", () => {
    const rows = [
      { id: "msg_1", content_json: doc(mention("ariadne", "ariadne", "user")) },
      { id: "msg_2", content_json: doc(mention("usr_alice", "alice", "user")) },
    ]

    const updates = resolveContentRows(
      rows,
      maps([["ariadne", { id: "persona_system_ariadne", actorType: "persona" }]])
    )

    expect(updates).toEqual([
      {
        id: "msg_1",
        contentJson: doc({
          type: "mention",
          attrs: { id: "persona_system_ariadne", slug: "ariadne", mentionType: "persona" },
        }),
        contentMarkdown: "[@ariadne](persona:persona_system_ariadne)",
      },
    ])
  })

  it("normalizes a broadcast mention even without a resolution map entry", () => {
    const rows = [{ id: "msg_1", content_json: doc(mention("here", "here", "user")) }]

    const updates = resolveContentRows(rows, maps())

    expect(updates).toEqual([
      {
        id: "msg_1",
        contentJson: doc({
          type: "mention",
          attrs: { id: "broadcast:here", slug: "here", mentionType: "broadcast" },
        }),
        contentMarkdown: "[@here](broadcast:here)",
      },
    ])
  })

  it("leaves already-resolved rows untouched (idempotent re-run)", () => {
    const rows = [
      {
        id: "msg_1",
        content_json: doc({
          type: "mention",
          attrs: { id: "persona_system_ariadne", slug: "ariadne", mentionType: "persona" },
        }),
      },
    ]

    const updates = resolveContentRows(
      rows,
      maps([["ariadne", { id: "persona_system_ariadne", actorType: "persona" }]])
    )

    expect(updates).toEqual([])
  })
})
