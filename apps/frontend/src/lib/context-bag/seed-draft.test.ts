import { describe, it, expect, beforeEach } from "vitest"
import { ContextRefKinds } from "@threa/types"
import { seedDraftWithContextRef } from "./seed-draft"
import { db } from "@/db"
import { resetDraftStoreCache } from "@/stores/draft-store"
import type { DraftContextRef } from "./types"

function makeRef(overrides: Partial<DraftContextRef> = {}): DraftContextRef {
  return {
    refKind: ContextRefKinds.THREAD,
    streamId: "stream_src",
    fromMessageId: null,
    toMessageId: null,
    originMessageId: null,
    status: "ready",
    fingerprint: null,
    errorMessage: null,
    ...overrides,
  }
}

describe("seedDraftWithContextRef", () => {
  beforeEach(async () => {
    resetDraftStoreCache()
    await db.drafts.clear()
    await db.composerLoaded.clear()
  })

  it("writes a loaded draft with the ref under contextRefs and an empty body", async () => {
    await seedDraftWithContextRef({ workspaceId: "ws_1", streamId: "stream_new", ref: makeRef() })

    const scope = "stream:stream_new"
    const loadedId = (await db.composerLoaded.get(scope))?.draftId ?? null
    expect(loadedId).not.toBeNull()

    const draft = await db.drafts.get(loadedId!)
    expect(draft).toMatchObject({ scope, workspaceId: "ws_1", attachments: [] })
    const refs = draft!.contextRefs as DraftContextRef[]
    expect(refs).toHaveLength(1)
    expect(refs[0].streamId).toBe("stream_src")
    expect(refs[0].status).toBe("ready")
  })

  it("sets the loaded pointer so the composer picks the draft up on first paint", async () => {
    await seedDraftWithContextRef({ workspaceId: "ws_1", streamId: "stream_new", ref: makeRef() })

    const pointer = await db.composerLoaded.get("stream:stream_new")
    expect(pointer?.workspaceId).toBe("ws_1")
    expect(pointer?.draftId?.startsWith("draft_")).toBe(true)
  })
})
