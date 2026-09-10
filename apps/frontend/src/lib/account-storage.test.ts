import { afterEach, describe, expect, it } from "vitest"
import { accountStorageKey, setStorageAccount } from "./account-storage"
import { readDraftTarget, writeDraftTarget, pushTargetMru, readTargetMru } from "./board-target-store"
import { clearStagedDraft, listStagedDrafts, readStagedDraft, stageDraftContent } from "./drafts/draft-staging"
import { loadTimelineAnchor, saveTimelineAnchor } from "./timeline-anchor-storage"
import { TEST_STORAGE_ACCOUNT } from "@/test/setup"

const ACCOUNT_A = "user_a"
const ACCOUNT_B = "user_b"
const WORKSPACE = "workspace_1"
const SCOPE = "stream_shared"

const body = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

afterEach(() => {
  setStorageAccount(TEST_STORAGE_ACCOUNT)
  localStorage.clear()
})

describe("account storage namespace", () => {
  it("should key by the account in scope and answer nothing when no account owns the tab", () => {
    setStorageAccount(ACCOUNT_A)
    expect(accountStorageKey("draft-stage:ws_1:scope")).toBe("threa:acct:user_a:draft-stage:ws_1:scope")

    setStorageAccount(null)
    expect(accountStorageKey("draft-stage:ws_1:scope")).toBeNull()
  })

  it("should stage, read and clear nothing at all while no account owns the tab", () => {
    setStorageAccount(null)
    stageDraftContent(WORKSPACE, SCOPE, body("typed with nobody signed in"))

    expect(localStorage.length).toBe(0)
    expect(readStagedDraft(WORKSPACE, SCOPE)).toBeNull()
    expect(listStagedDrafts(WORKSPACE)).toEqual([])
    expect(readDraftTarget(WORKSPACE)).toBe("")
    expect(readTargetMru(WORKSPACE)).toEqual([])
    expect(loadTimelineAnchor("stream_1")).toBeNull()

    // And the unowned writes left nothing behind for the next account either.
    writeDraftTarget(WORKSPACE, "stream_x")
    pushTargetMru(WORKSPACE, "stream_x")
    saveTimelineAnchor("stream_1", { targetId: "msg_1", offsetPx: 12 })
    expect(localStorage.length).toBe(0)
  })
})

describe("account-owned browser storage", () => {
  it("should keep one account's staged draft out of the next account's composer and reconcile", () => {
    setStorageAccount(ACCOUNT_A)
    stageDraftContent(WORKSPACE, SCOPE, body("A's unsent tail"))
    expect(readStagedDraft(WORKSPACE, SCOPE)?.contentJson).toEqual(body("A's unsent tail"))

    setStorageAccount(ACCOUNT_B)
    expect(readStagedDraft(WORKSPACE, SCOPE)).toBeNull()
    expect(listStagedDrafts(WORKSPACE)).toEqual([])

    stageDraftContent(WORKSPACE, SCOPE, body("B's own tail"))
    expect(listStagedDrafts(WORKSPACE)).toEqual([
      { scope: SCOPE, contentJson: body("B's own tail"), clientUpdatedAt: expect.any(Number) },
    ])

    // Back on A: A's own work is exactly where A left it, and B's clear did not
    // reach it.
    setStorageAccount(ACCOUNT_A)
    expect(readStagedDraft(WORKSPACE, SCOPE)?.contentJson).toEqual(body("A's unsent tail"))
  })

  it("should leave a staged draft written before the key carried an owner unreadable and unrecovered", () => {
    // Exactly what a client from before this shipped wrote: workspace + scope,
    // no owner anywhere in the key.
    localStorage.setItem(
      `threa:draft-stage:${WORKSPACE}:${SCOPE}`,
      JSON.stringify({ contentJson: body("an unknown account's draft"), clientUpdatedAt: Date.now() })
    )

    setStorageAccount(ACCOUNT_B)
    expect(readStagedDraft(WORKSPACE, SCOPE)).toBeNull()
    expect(listStagedDrafts(WORKSPACE)).toEqual([])
    clearStagedDraft(WORKSPACE, SCOPE)

    // Preserved rather than deleted — whose it is, is exactly what is unknown.
    expect(localStorage.getItem(`threa:draft-stage:${WORKSPACE}:${SCOPE}`)).not.toBeNull()
  })

  it("should keep the board composer's target and recents with the account that chose them", () => {
    setStorageAccount(ACCOUNT_A)
    writeDraftTarget(WORKSPACE, "stream_a_private")
    pushTargetMru(WORKSPACE, "stream_a_private")

    setStorageAccount(ACCOUNT_B)
    expect(readDraftTarget(WORKSPACE)).toBe("")
    expect(readTargetMru(WORKSPACE)).toEqual([])

    setStorageAccount(ACCOUNT_A)
    expect(readDraftTarget(WORKSPACE)).toBe("stream_a_private")
    expect(readTargetMru(WORKSPACE)).toEqual(["stream_a_private"])
  })

  it("should keep a reader's timeline anchor with the account that was reading", () => {
    setStorageAccount(ACCOUNT_A)
    saveTimelineAnchor("stream_shared", { targetId: "msg_7", offsetPx: -20 })

    setStorageAccount(ACCOUNT_B)
    expect(loadTimelineAnchor("stream_shared")).toBeNull()
    saveTimelineAnchor("stream_shared", { targetId: "msg_99", offsetPx: 0 })

    setStorageAccount(ACCOUNT_A)
    expect(loadTimelineAnchor("stream_shared")).toEqual({ targetId: "msg_7", offsetPx: -20 })
  })
})
