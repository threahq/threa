import { beforeEach, describe, expect, it } from "vitest"
import { db } from "@/db"
import { sharedMessageSlotKey, type SharedMessageSlot, type SlotMap } from "@threa/types"
import { writeSlotCarrier, deleteStreamSlots, deleteSlotsForStreams } from "./slot-store"

function slot(messageId: string, contentMarkdown = "body"): SharedMessageSlot {
  return {
    type: "sharedMessage",
    state: "ok",
    messageId,
    streamId: "stream_src",
    authorId: "usr_1",
    authorType: "user",
    authorName: null,
    contentJson: { type: "doc", content: [] },
    contentMarkdown,
    editedAt: null,
    createdAt: "2026-04-23T10:00:00Z",
    attachments: [],
  }
}

function privateSlot(messageId: string): SharedMessageSlot {
  return {
    type: "sharedMessage",
    state: "private",
    messageId,
    sourceStreamKind: "channel",
    sourceVisibility: "private",
  }
}

function truncatedSlot(messageId: string): SharedMessageSlot {
  return { type: "sharedMessage", state: "truncated", messageId, streamId: "stream_src" }
}

function deletedSlot(messageId: string): SharedMessageSlot {
  return { type: "sharedMessage", state: "deleted", messageId, deletedAt: "2026-04-24T00:00:00Z" }
}

function missingSlot(messageId: string): SharedMessageSlot {
  return { type: "sharedMessage", state: "missing", messageId }
}

/** A window event whose content references the given source messages. */
function eventReferencing(...messageIds: string[]): { payload: unknown } {
  return {
    payload: {
      contentJson: {
        type: "doc",
        content: messageIds.map((messageId) => ({
          type: "sharedMessage",
          attrs: { messageId, streamId: "stream_src" },
        })),
      },
    },
  }
}

async function readMap(streamId: string): Promise<SlotMap> {
  const rows = await db.slots.where("streamId").equals(streamId).toArray()
  const map: SlotMap = {}
  for (const row of rows) map[row.slotKey] = row.value
  return map
}

beforeEach(async () => {
  await db.slots.clear()
})

describe("writeSlotCarrier — write-boundary normalization", () => {
  it("writes canonical carrier rows keyed by their canonical slot key", async () => {
    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [sharedMessageSlotKey("msg_1")]: slot("msg_1") } },
      mode: "merge",
      cachedAt: 1,
    })

    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") })
    const row = await db.slots.where("streamId").equals("stream_a").first()
    expect(row).toMatchObject({ workspaceId: "ws_1", streamId: "stream_a", slotKey: "shared:msg_1" })
  })

  it("rekeys a legacy-only carrier from each value's own messageId", async () => {
    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      // A stale/wrong legacy key must not inject a wrong canonical entry — the
      // value's messageId is authoritative.
      carrier: { sharedMessages: { wrong_key: slot("msg_1") } },
      mode: "merge",
      cachedAt: 1,
    })

    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1") })
  })

  it("prefers the canonical map when both carriers are present", async () => {
    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: {
        slots: { [sharedMessageSlotKey("msg_1")]: slot("msg_1", "canonical") },
        sharedMessages: { msg_1: slot("msg_1", "legacy") },
      },
      mode: "merge",
      cachedAt: 1,
    })

    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_1")]: slot("msg_1", "canonical") })
  })

  it("treats an empty canonical map as authoritative — does not fall through to legacy", async () => {
    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: {}, sharedMessages: { msg_1: slot("msg_1") } },
      mode: "merge",
      cachedAt: 1,
    })

    expect(await readMap("stream_a")).toEqual({})
  })

  it("performs no mutation for a map-less carrier (old-server tolerance)", async () => {
    await db.slots.put({
      workspaceId: "ws_1",
      streamId: "stream_a",
      slotKey: sharedMessageSlotKey("msg_existing"),
      value: slot("msg_existing"),
      _cachedAt: 1,
    })

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: {},
      mode: "replace",
      // Even with window references, a map-less carrier performs no mutation
      // at all — not even the window-scoped delete.
      windowEvents: [eventReferencing("msg_existing")],
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_existing")]: slot("msg_existing") })
  })
})

describe("writeSlotCarrier — merge vs replace", () => {
  it("merge upserts incoming keys and leaves others intact (last-writer-wins per key)", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_1"),
        value: slot("msg_1", "old"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_2"),
        value: slot("msg_2"),
        _cachedAt: 1,
      },
    ])

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [sharedMessageSlotKey("msg_1")]: slot("msg_1", "new") } },
      mode: "merge",
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({
      [sharedMessageSlotKey("msg_1")]: slot("msg_1", "new"),
      [sharedMessageSlotKey("msg_2")]: slot("msg_2"),
    })
  })

  it("replace writes the window snapshot and leaves other streams untouched", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_fresh"),
        value: slot("msg_fresh", "old"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_other",
        slotKey: sharedMessageSlotKey("msg_keep"),
        value: slot("msg_keep"),
        _cachedAt: 1,
      },
    ])

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [sharedMessageSlotKey("msg_fresh")]: slot("msg_fresh") } },
      mode: "replace",
      windowEvents: [eventReferencing("msg_fresh")],
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_fresh")]: slot("msg_fresh") })
    expect(await readMap("stream_other")).toEqual({ [sharedMessageSlotKey("msg_keep")]: slot("msg_keep") })
  })

  it("replace with an empty canonical map clears only the window's referenced keys", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_gone"),
        value: slot("msg_gone"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_elsewhere"),
        value: slot("msg_elsewhere"),
        _cachedAt: 1,
      },
    ])

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: {} },
      mode: "replace",
      windowEvents: [eventReferencing("msg_gone")],
      cachedAt: 2,
    })

    // The window no longer carries msg_gone's reference, so its row resets;
    // msg_elsewhere belongs to an out-of-window page and survives.
    expect(await readMap("stream_a")).toEqual({ [sharedMessageSlotKey("msg_elsewhere")]: slot("msg_elsewhere") })
  })
})

describe("writeSlotCarrier — merge richness guard (B1)", () => {
  const key = sharedMessageSlotKey("msg_1")

  async function mergeOver(existing: SharedMessageSlot, incoming: SharedMessageSlot): Promise<SlotMap> {
    await db.slots.put({ workspaceId: "ws_1", streamId: "stream_a", slotKey: key, value: existing, _cachedAt: 1 })
    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [key]: incoming } },
      mode: "merge",
      cachedAt: 2,
    })
    return readMap("stream_a")
  }

  const cases: Array<{
    name: string
    existing: SharedMessageSlot
    incoming: SharedMessageSlot
    expected: SharedMessageSlot
  }> = [
    {
      name: "ok + private keeps the rendered ok",
      existing: slot("msg_1"),
      incoming: privateSlot("msg_1"),
      expected: slot("msg_1"),
    },
    {
      name: "ok + truncated keeps the rendered ok",
      existing: slot("msg_1"),
      incoming: truncatedSlot("msg_1"),
      expected: slot("msg_1"),
    },
    {
      name: "ok + deleted converges to the objective tombstone",
      existing: slot("msg_1"),
      incoming: deletedSlot("msg_1"),
      expected: deletedSlot("msg_1"),
    },
    {
      name: "ok + missing converges to missing",
      existing: slot("msg_1"),
      incoming: missingSlot("msg_1"),
      expected: missingSlot("msg_1"),
    },
    {
      name: "ok + ok takes the fresher incoming content",
      existing: slot("msg_1", "old"),
      incoming: slot("msg_1", "new"),
      expected: slot("msg_1", "new"),
    },
    {
      name: "private + ok upgrades to the rendered content",
      existing: privateSlot("msg_1"),
      incoming: slot("msg_1"),
      expected: slot("msg_1"),
    },
    {
      name: "truncated + ok upgrades to the rendered content",
      existing: truncatedSlot("msg_1"),
      incoming: slot("msg_1"),
      expected: slot("msg_1"),
    },
  ]

  it.each(cases)("$name", async ({ existing, incoming, expected }) => {
    expect(await mergeOver(existing, incoming)).toEqual({ [key]: expected })
  })

  it("does not apply in replace mode — access downgrades flow through the authoritative replace", async () => {
    await db.slots.put({ workspaceId: "ws_1", streamId: "stream_a", slotKey: key, value: slot("msg_1"), _cachedAt: 1 })

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [key]: privateSlot("msg_1") } },
      mode: "replace",
      windowEvents: [eventReferencing("msg_1")],
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({ [key]: privateSlot("msg_1") })
  })
})

describe("writeSlotCarrier — replace window-scoping (B2)", () => {
  it("refreshes in-window keys (including ones an out-of-window page also holds) and leaves the rest intact", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_in_window"),
        value: slot("msg_in_window", "old"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_out_of_window"),
        value: slot("msg_out_of_window", "older page"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_orphan"),
        value: slot("msg_orphan", "orphan"),
        _cachedAt: 1,
      },
    ])

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: {
        slots: {
          [sharedMessageSlotKey("msg_in_window")]: slot("msg_in_window", "new"),
          // Nested hydration entries ride the carrier without being referenced
          // by any window event — written, never deleted.
          [sharedMessageSlotKey("msg_nested")]: slot("msg_nested", "nested"),
        },
      },
      mode: "replace",
      windowEvents: [eventReferencing("msg_in_window")],
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({
      [sharedMessageSlotKey("msg_in_window")]: slot("msg_in_window", "new"),
      [sharedMessageSlotKey("msg_out_of_window")]: slot("msg_out_of_window", "older page"),
      [sharedMessageSlotKey("msg_orphan")]: slot("msg_orphan", "orphan"),
      [sharedMessageSlotKey("msg_nested")]: slot("msg_nested", "nested"),
    })
  })

  it("replace whose window references nothing deletes nothing (pure upsert)", async () => {
    await db.slots.put({
      workspaceId: "ws_1",
      streamId: "stream_a",
      slotKey: sharedMessageSlotKey("msg_existing"),
      value: slot("msg_existing"),
      _cachedAt: 1,
    })

    await writeSlotCarrier({
      database: db,
      workspaceId: "ws_1",
      streamId: "stream_a",
      carrier: { slots: { [sharedMessageSlotKey("msg_new")]: slot("msg_new") } },
      mode: "replace",
      windowEvents: [],
      cachedAt: 2,
    })

    expect(await readMap("stream_a")).toEqual({
      [sharedMessageSlotKey("msg_existing")]: slot("msg_existing"),
      [sharedMessageSlotKey("msg_new")]: slot("msg_new"),
    })
  })
})

describe("slot eviction helpers", () => {
  it("deleteStreamSlots drops only the target stream's rows", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_1"),
        value: slot("msg_1"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_b",
        slotKey: sharedMessageSlotKey("msg_2"),
        value: slot("msg_2"),
        _cachedAt: 1,
      },
    ])

    await deleteStreamSlots(db, "stream_a")

    expect(await readMap("stream_a")).toEqual({})
    expect(await readMap("stream_b")).toEqual({ [sharedMessageSlotKey("msg_2")]: slot("msg_2") })
  })

  it("deleteSlotsForStreams drops every listed stream in one pass", async () => {
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId: "stream_a",
        slotKey: sharedMessageSlotKey("msg_1"),
        value: slot("msg_1"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_b",
        slotKey: sharedMessageSlotKey("msg_2"),
        value: slot("msg_2"),
        _cachedAt: 1,
      },
      {
        workspaceId: "ws_1",
        streamId: "stream_c",
        slotKey: sharedMessageSlotKey("msg_3"),
        value: slot("msg_3"),
        _cachedAt: 1,
      },
    ])

    await deleteSlotsForStreams(db, ["stream_a", "stream_b"])

    expect(await readMap("stream_a")).toEqual({})
    expect(await readMap("stream_b")).toEqual({})
    expect(await readMap("stream_c")).toEqual({ [sharedMessageSlotKey("msg_3")]: slot("msg_3") })
  })
})
