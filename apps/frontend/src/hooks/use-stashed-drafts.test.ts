import { describe, it, expect, beforeEach } from "vitest"
import { stashLoadedDraft, restoreStashedDraftToComposer, upsertLoadedDraft } from "./use-draft-message"
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
  await db.pendingOperations.clear()
})

describe("stashLoadedDraft (pointer-move stash)", () => {
  it("detaches the loaded pointer but keeps the row at rest, so it roams as a stash entry", async () => {
    const loaded = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("draft body"), attachments: [] })
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(loaded.id)

    const stashedId = await stashLoadedDraft(workspaceId, scope)

    expect(stashedId).toBe(loaded.id)
    // Pointer cleared; the row is preserved (not deleted) so it stays a stash entry
    // and keeps roaming — no plaintext snapshot into a new row.
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
    expect(await db.drafts.get(loaded.id)).toBeDefined()
  })

  it("no-ops when nothing is loaded", async () => {
    expect(await stashLoadedDraft(workspaceId, scope)).toBeNull()
  })

  it("keeps a sealed E2E row at rest — never writes plaintext (E2EE-4)", async () => {
    await db.drafts.put({
      id: "draft_sealed",
      workspaceId,
      scope,
      contentJson: EMPTY_DOC,
      attachments: [],
      ciphertext: "ct_sealed",
      envelope: { v: 2 },
      e2eVersion: 2,
      clientUpdatedAt: Date.now(),
    })
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_sealed" })

    const stashedId = await stashLoadedDraft(workspaceId, scope)

    expect(stashedId).toBe("draft_sealed")
    const row = await db.drafts.get("draft_sealed")
    expect(row?.ciphertext).toBe("ct_sealed")
    // Still ciphertext-only at rest after stashing.
    expect(row?.contentJson).toEqual(EMPTY_DOC)
    expect(await db.composerLoaded.get(scope)).toBeUndefined()
  })
})

describe("restoreStashedDraftToComposer (pointer-move restore)", () => {
  it("points the scope at the chosen row; the previously-loaded one becomes the stash entry", async () => {
    const first = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("first"), attachments: [] })
    await stashLoadedDraft(workspaceId, scope)
    const second = await upsertLoadedDraft(workspaceId, scope, { contentJson: makeDoc("second"), attachments: [] })
    expect((await db.composerLoaded.get(scope))?.draftId).toBe(second.id)

    await restoreStashedDraftToComposer(workspaceId, scope, first.id)

    expect((await db.composerLoaded.get(scope))?.draftId).toBe(first.id)
    // Both rows survive (nothing deleted) — `second` is now the stash entry.
    expect(await db.drafts.get(first.id)).toBeDefined()
    expect(await db.drafts.get(second.id)).toBeDefined()
  })
})
