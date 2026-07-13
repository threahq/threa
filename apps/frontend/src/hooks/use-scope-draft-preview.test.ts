import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import { useScopeDraftPreview, useBoardSubtopicDraftIndex } from "./use-scope-draft-preview"

const workspaceId = "ws_1"
const scope = "board:reply:conv_1"

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : undefined }],
})

async function seed(id: string, draftScope: string, text: string, clientUpdatedAt: number) {
  await db.drafts.add({ id, workspaceId, scope: draftScope, contentJson: doc(text), attachments: [], clientUpdatedAt })
}

beforeEach(async () => {
  await db.drafts.clear()
  await db.composerLoaded.clear()
})

describe("useScopeDraftPreview", () => {
  it("returns null when the scope has no draft with payload", async () => {
    await seed("draft_empty", scope, "", 1000)
    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current).toBeNull()
  })

  it("prefers the checked-out row over a newer stashed sibling", async () => {
    await seed("draft_loaded", scope, "checked out body", 1000)
    await seed("draft_stashed", scope, "newer stashed body", 2000)
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_loaded" })

    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() =>
      expect(result.current).toMatchObject({ draftId: "draft_loaded", preview: "checked out body", isCheckedOut: true })
    )
  })

  it("falls back to the newest row (not checked out) when the pointer is absent — the roamed-draft shape", async () => {
    await seed("draft_old", scope, "older", 1000)
    await seed("draft_new", scope, "newest roamed body", 2000)

    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() =>
      expect(result.current).toMatchObject({ draftId: "draft_new", preview: "newest roamed body", isCheckedOut: false })
    )
  })
})

describe("useBoardSubtopicDraftIndex", () => {
  it("keys sub-topic drafts by their fork message id, ignoring other scopes", async () => {
    await seed("draft_st", "board:subtopic:stream_9:msg_fork", "subtopic body", 1000)
    await seed("draft_reply", "board:reply:conv_1", "reply body", 1000)

    const { result } = renderHook(() => useBoardSubtopicDraftIndex(workspaceId))
    await waitFor(() => expect(result.current.size).toBe(1))
    expect(result.current.get("msg_fork")).toMatchObject({
      draftId: "draft_st",
      streamId: "stream_9",
      scope: "board:subtopic:stream_9:msg_fork",
      preview: "subtopic body",
      isCheckedOut: false,
    })
  })
})
