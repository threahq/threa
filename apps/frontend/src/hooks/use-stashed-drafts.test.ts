import { describe, it, expect, beforeEach } from "vitest"
import { createStashedDraft, popStashedDraft } from "./use-stashed-drafts"
import { upsertLoadedDraft } from "./use-draft-message"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"

const makeDoc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})
const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }

const workspaceId = "ws_123"
const scope = "stream:stream_456"

beforeEach(async () => {
  resetDraftStoreCache()
  await db.drafts.clear()
  await db.composerLoaded.clear()
})

describe("createStashedDraft", () => {
  it("persists a draft_-prefixed row with workspaceId, scope, and contentJson", async () => {
    const content = makeDoc("Hello saved world")

    const row = await createStashedDraft(workspaceId, scope, { contentJson: content })

    expect(row).not.toBeNull()
    expect(row!.workspaceId).toBe(workspaceId)
    expect(row!.scope).toBe(scope)
    expect(row!.contentJson).toEqual(content)
    expect(row!.id.startsWith("draft_")).toBe(true)

    const persisted = await db.drafts.get(row!.id)
    expect(persisted).toMatchObject({ workspaceId, scope, contentJson: content })
  })

  it("no-ops on empty content with no attachments", async () => {
    const row = await createStashedDraft(workspaceId, scope, { contentJson: EMPTY_DOC })

    expect(row).toBeNull()
    expect(await db.drafts.count()).toBe(0)
  })

  it("stashes attachment-only drafts (empty body + attachments)", async () => {
    const attachments = [{ id: "attach_1", filename: "a.png", mimeType: "image/png", sizeBytes: 10 }]

    const row = await createStashedDraft(workspaceId, scope, { contentJson: EMPTY_DOC, attachments })

    expect(row).not.toBeNull()
    expect(row!.attachments).toEqual(attachments)
    expect(await db.drafts.count()).toBe(1)
  })

  it("no-ops when scope is undefined (host still resolving)", async () => {
    const row = await createStashedDraft(workspaceId, undefined, { contentJson: makeDoc("x") })

    expect(row).toBeNull()
    expect(await db.drafts.count()).toBe(0)
  })

  it("no-ops when workspaceId is empty", async () => {
    const row = await createStashedDraft("", scope, { contentJson: makeDoc("x") })

    expect(row).toBeNull()
    expect(await db.drafts.count()).toBe(0)
  })

  it("never resurrects the loaded draft — a stash is a separate row", async () => {
    const loaded = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("loaded"), attachments: [] })
    const stash = await createStashedDraft(workspaceId, scope, { contentJson: makeDoc("stashed") })

    expect(stash!.id).not.toBe(loaded.id)
    expect(await db.drafts.count()).toBe(2)
    // The loaded pointer is untouched by stashing.
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(loaded.id)
  })
})

describe("popStashedDraft", () => {
  it("returns the row and deletes it from the table", async () => {
    const created = await createStashedDraft(workspaceId, scope, { contentJson: makeDoc("Saved earlier") })

    const restored = await popStashedDraft(created!.id)

    expect(restored?.id).toBe(created!.id)
    expect(restored?.contentJson).toEqual(makeDoc("Saved earlier"))
    expect(await db.drafts.get(created!.id)).toBeUndefined()
  })

  it("returns null when the row is missing (no-op delete)", async () => {
    const restored = await popStashedDraft("draft_missing")

    expect(restored).toBeNull()
  })
})
