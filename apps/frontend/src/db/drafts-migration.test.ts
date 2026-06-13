import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { ThreaDatabase } from "./database"

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

describe("v34 drafts migration", () => {
  it("folds draftMessages + stashedDrafts into drafts + composerLoaded", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`

    // Seed an old-schema database carrying the two pre-unification draft tables.
    const legacy = new Dexie(name)
    legacy.version(33).stores({
      draftMessages: "id, workspaceId, updatedAt",
      stashedDrafts: "id, workspaceId, scope, [workspaceId+scope], createdAt",
    })
    await legacy.open()
    await legacy.table("draftMessages").put({
      id: "stream:stream_1",
      workspaceId: "ws_1",
      contentJson: doc("ambient"),
      attachments: [{ id: "a1", filename: "f", mimeType: "text/plain", sizeBytes: 1 }],
      updatedAt: 1000,
    })
    await legacy.table("stashedDrafts").put({
      id: "stash_1",
      workspaceId: "ws_1",
      scope: "stream:stream_1",
      contentJson: doc("stashed"),
      createdAt: 2000,
    })
    legacy.close()

    // Reopen through the app schema — runs the v34 upgrade.
    const db = new ThreaDatabase(name)
    await db.open()

    const drafts = await db.drafts.toArray()
    const loaded = await db.composerLoaded.toArray()

    // One draft per old row; the ambient becomes the loaded pointer, the stash stays unloaded.
    expect(drafts).toHaveLength(2)
    expect(loaded).toHaveLength(1)

    const pointer = loaded[0]
    expect(pointer.scope).toBe("stream:stream_1")
    expect(pointer.workspaceId).toBe("ws_1")

    const ambient = drafts.find((d) => d.id === pointer.draftId)
    expect(ambient).toMatchObject({ scope: "stream:stream_1", workspaceId: "ws_1", clientUpdatedAt: 1000 })
    expect(ambient!.contentJson).toEqual(doc("ambient"))
    expect(ambient!.attachments).toHaveLength(1)
    expect(ambient!.id.startsWith("draft_")).toBe(true)

    const stash = drafts.find((d) => d.id !== pointer.draftId)
    expect(stash).toMatchObject({ scope: "stream:stream_1", workspaceId: "ws_1", clientUpdatedAt: 2000 })
    expect(stash!.contentJson).toEqual(doc("stashed"))

    // The old stores are dropped.
    expect(db.tables.some((t) => t.name === "draftMessages")).toBe(false)
    expect(db.tables.some((t) => t.name === "stashedDrafts")).toBe(false)

    db.close()
    await Dexie.delete(name)
  })
})
