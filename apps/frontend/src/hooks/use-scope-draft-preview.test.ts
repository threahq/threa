import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import {
  useScopeDraftPreview,
  useBoardSubtopicDraftIndex,
  useBoardCheckedOutDraftScopes,
  useBoardDraftsReady,
  __clearBoardDraftsRegistry,
} from "./use-scope-draft-preview"

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
  __clearBoardDraftsRegistry()
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

  it("throws on a non-board scope — the shared snapshot only covers board:* rows", () => {
    expect(() => renderHook(() => useScopeDraftPreview(workspaceId, "stream:stream_1"))).toThrow(/board draft scopes/)
  })
})

describe("useBoardDraftsReady", () => {
  it("is false until the shared snapshot's first read lands, then true — and the settled snapshot serves scope reads synchronously", async () => {
    await seed("draft_1", scope, "body", 1000)
    const ready = renderHook(() => useBoardDraftsReady(workspaceId))
    expect(ready.result.current).toBe(false)
    await waitFor(() => expect(ready.result.current).toBe(true))

    // A hook mounting AFTER the snapshot resolved (a card painting post-reveal)
    // reads its preview in its very first render — no post-mount pop-in.
    const preview = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    expect(preview.result.current).toMatchObject({ draftId: "draft_1", preview: "body" })
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

describe("useBoardCheckedOutDraftScopes", () => {
  it("holds an emptied checked-out scope the preview index drops, and releases it when the row goes", async () => {
    await seed("draft_1", scope, "body", 1000)
    await db.composerLoaded.put({ scope, workspaceId, draftId: "draft_1" })

    const { result } = renderHook(() => useBoardCheckedOutDraftScopes(workspaceId))
    const preview = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() => expect([...result.current]).toEqual([scope]))

    const row = await db.drafts.get("draft_1")
    await db.drafts.put({ ...row!, contentJson: doc(""), clientUpdatedAt: 2000 })
    await waitFor(() => expect(preview.result.current).toBeNull())
    expect([...result.current]).toEqual([scope])

    await db.drafts.delete("draft_1")
    await waitFor(() => expect([...result.current]).toEqual([]))
  })

  it("excludes a scope with no loaded pointer", async () => {
    await seed("draft_1", scope, "body", 1000)
    const { result } = renderHook(() => useBoardCheckedOutDraftScopes(workspaceId))
    const ready = renderHook(() => useBoardDraftsReady(workspaceId))
    await waitFor(() => expect(ready.result.current).toBe(true))
    expect([...result.current]).toEqual([])
  })
})
