import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { JSONContent } from "@threa/types"
import { db } from "@/db"
import {
  useScopeDraftPreview,
  useBoardDraftPayloadScopes,
  useBoardScopeDraftIndex,
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

async function seedContent(id: string, draftScope: string, contentJson: JSONContent, clientUpdatedAt: number) {
  await db.drafts.add({ id, workspaceId, scope: draftScope, contentJson, attachments: [], clientUpdatedAt })
}

async function seed(id: string, draftScope: string, text: string, clientUpdatedAt: number) {
  await seedContent(id, draftScope, doc(text), clientUpdatedAt)
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

  it("uses the shared collapsed-composer projection for structural draft content", async () => {
    await seedContent(
      "draft_command",
      scope,
      {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "slashCommand", attrs: { name: "steer", clientActionId: null } },
              { type: "text", text: " focus on tests" },
            ],
          },
        ],
      },
      1000
    )

    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() => expect(result.current?.preview).toBe("/steer focus on tests"))
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

describe("stashed rows (durable stash, chunk 4)", () => {
  it("never advertises a stashed row — the resting button rests instead of un-doing the stash", async () => {
    await db.drafts.add({
      id: "d_stashed",
      workspaceId,
      scope,
      contentJson: doc("put away"),
      attachments: [],
      clientUpdatedAt: 2000,
      stashedAt: 1500,
    })
    // Control: an OLDER roamed (non-stashed) sibling is what gets advertised —
    // proving the filter picked by flag, not by recency accident.
    await seed("d_roamed", scope, "roamed body", 1000)

    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() => expect(result.current?.draftId).toBe("d_roamed"))
  })

  it("returns null when every payload row is stashed", async () => {
    await db.drafts.add({
      id: "d_only_stashed",
      workspaceId,
      scope,
      contentJson: doc("put away"),
      attachments: [],
      clientUpdatedAt: 2000,
      stashedAt: 1500,
    })
    // Control on the same snapshot: a sibling scope with a live row still
    // advertises, so the null is the flag's doing, not an empty snapshot.
    await seed("d_live", "board:reply:conv_2", "live", 1000)

    const { result } = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    const control = renderHook(() => useScopeDraftPreview(workspaceId, "board:reply:conv_2"))
    await waitFor(() => expect(control.result.current?.draftId).toBe("d_live"))
    expect(result.current).toBeNull()
  })
})

describe("membership vs advertising (payloadScopes)", () => {
  it("keeps a stashed-only scope in the membership set while the advertise index drops it", async () => {
    await db.drafts.add({
      id: "d_member",
      workspaceId,
      scope,
      contentJson: doc("stashed away"),
      attachments: [],
      clientUpdatedAt: 2000,
      stashedAt: 1500,
    })
    await seed("d_other", "board:reply:conv_2", "live", 1000)

    const membership = renderHook(() => useBoardDraftPayloadScopes(workspaceId))
    const advertise = renderHook(() => useBoardScopeDraftIndex(workspaceId))
    await waitFor(() => expect(membership.result.current.has(scope)).toBe(true))
    expect(membership.result.current.has("board:reply:conv_2")).toBe(true)
    expect(advertise.result.current.has(scope)).toBe(false)
    expect(advertise.result.current.has("board:reply:conv_2")).toBe(true)
  })
})

describe("sub-topic indicator is membership, not advertising", () => {
  it("keeps the fork-message entry for a put-away sub-topic draft while the reply button drops its preview", async () => {
    const subScope = "board:subtopic:stream_9:msg_fork"
    await db.drafts.add({
      id: "d_sub_stashed",
      workspaceId,
      scope: subScope,
      contentJson: doc("forked thought"),
      attachments: [],
      clientUpdatedAt: 2000,
      stashedAt: 1500,
    })
    // Control on the same snapshot: a conversation-reply scope with a put-away
    // row loses its ADVERTISING preview — that filter is real and untouched.
    await db.drafts.add({
      id: "d_conv_stashed",
      workspaceId,
      scope,
      contentJson: doc("stashed reply"),
      attachments: [],
      clientUpdatedAt: 2000,
      stashedAt: 1500,
    })

    const subtopics = renderHook(() => useBoardSubtopicDraftIndex(workspaceId))
    const preview = renderHook(() => useScopeDraftPreview(workspaceId, scope))
    await waitFor(() => expect(subtopics.result.current.get("msg_fork")?.draftId).toBe("d_sub_stashed"))
    expect(preview.result.current).toBeNull()
    subtopics.unmount()
    preview.unmount()
  })
})

// Named after the staging failure it guards (Kris, 2026-08-06): "stashing on the
// board … leaves the board's preview composer (the button) still showing it as
// if the draft is there and then loads with the drafts despite explicitly
// stashing". The full round-trip through the REAL stash machinery: stash →
// button rests (no advertisement, so no auto-restore either) while the pile
// still offers the row.
describe("staging repro: stash on the board sticks", () => {
  it("after stashLoadedDraft the resting button advertises nothing and the pile still has the row", async () => {
    const { stashLoadedDraft, upsertLoadedDraft } = await import("./use-draft-message")
    const { resetDraftStoreCache, seedDraftCacheFromIdb } = await import("@/stores/draft-store")
    const { useStashedDrafts } = await import("./use-stashed-drafts")
    resetDraftStoreCache()
    await db.pendingOperations.clear()
    await db.streams.clear()
    await db.conversations.clear()
    await db.streams.put({
      id: "stream_rt",
      workspaceId,
      type: "channel",
      visibility: "private",
      rootStreamId: null,
      archivedAt: null,
    } as never)
    await db.conversations.put({
      id: "conv_rt",
      workspaceId,
      _lastActivityMs: 1,
      _cachedAt: 1,
      conversation: { id: "conv_rt", streamId: "stream_rt", messageIds: ["msg_rt"] },
      openingMessage: { id: "msg_rt" },
      recentMessages: [],
    } as never)
    const rtScope = "board:reply:conv_rt"
    await upsertLoadedDraft(workspaceId, rtScope, { contentJson: doc("typed on the board"), attachments: [] })
    await seedDraftCacheFromIdb(workspaceId)

    // Observe the loaded advertisement first so the negative assertion below
    // cannot pass merely because the live query has not hydrated yet.
    const preview = renderHook(() => useScopeDraftPreview(workspaceId, rtScope))
    await waitFor(() => expect(preview.result.current).toMatchObject({ preview: "typed on the board" }))

    const stashedId = await stashLoadedDraft(workspaceId, rtScope)
    expect(stashedId).not.toBeNull()

    // Button rests: nothing advertised, so the open-time auto-restore
    // (restoreStashedIdOnMount derives from this same preview) has nothing to fire.
    await waitFor(() => expect(preview.result.current).toBeNull())
    // The pile still offers the row — stash hides it from the button, never
    // from the picker.
    const pile = renderHook(() => useStashedDrafts(workspaceId, rtScope))
    await waitFor(() => expect(pile.result.current.drafts.map((d) => d.id)).toContain(stashedId))
    preview.unmount()
    pile.unmount()
  })
})
