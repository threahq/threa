import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db, type CachedConversationMessage } from "@/db"
import type { BoardPostMessage } from "@threa/types"
import {
  __resetConversationMessageSnapshots,
  conversationMessagesPrimed,
  deleteConversationMessages,
  patchConversationMessage,
  primeConversationMessages,
  pruneConversationMessagesToMembership,
  seedConversationMessages,
  useBoardBackfillPrimed,
  useConversationBackfillMessages,
} from "./conversation-messages-store"

const WS = "ws_1"
const CONV_A = "conv_a"
const CONV_B = "conv_b"

function message(id: string, overrides: Partial<BoardPostMessage> = {}): BoardPostMessage {
  return {
    id,
    streamId: "stream_1",
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: `body ${id}`,
    reactions: {},
    attachments: [],
    linkPreviews: [],
    createdAt: "2026-07-01T10:00:00.000Z",
    editedAt: null,
    ...overrides,
  }
}

/** The persisted row minus its write-time cache stamp, so a whole-row comparison
 *  (INV-24) doesn't depend on the clock. */
function rowsOf(rows: CachedConversationMessage[]): Omit<CachedConversationMessage, "_cachedAt">[] {
  return rows.map(({ _cachedAt: _ignored, ...row }) => row).sort((a, b) => (a.messageId < b.messageId ? -1 : 1))
}

beforeEach(async () => {
  await db.conversationMessages.clear()
  __resetConversationMessageSnapshots()
})

describe("seedConversationMessages", () => {
  it("replaces the conversation's prior rows — a stale member drops, the new one lands", async () => {
    await seedConversationMessages(WS, CONV_A, [message("m1"), message("m_stale")])
    await seedConversationMessages(WS, CONV_A, [message("m1", { contentMarkdown: "edited" }), message("m_new")])

    expect(rowsOf(await db.conversationMessages.toArray())).toEqual([
      { ...message("m1", { contentMarkdown: "edited" }), messageId: "m1", conversationId: CONV_A, workspaceId: WS },
      { ...message("m_new"), messageId: "m_new", conversationId: CONV_A, workspaceId: WS },
    ])
  })

  it("clears the conversation's rows when the fetch comes back empty (replace, not skip)", async () => {
    await seedConversationMessages(WS, CONV_A, [message("m1")])
    await seedConversationMessages(WS, CONV_B, [message("b1")])

    await seedConversationMessages(WS, CONV_A, [])

    expect(rowsOf(await db.conversationMessages.toArray())).toEqual([
      { ...message("b1"), messageId: "b1", conversationId: CONV_B, workspaceId: WS },
    ])
  })

  it("leaves another conversation's rows untouched", async () => {
    await seedConversationMessages(WS, CONV_B, [message("b1")])
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    await seedConversationMessages(WS, CONV_A, [message("a2")])

    expect(rowsOf(await db.conversationMessages.where("conversationId").equals(CONV_B).toArray())).toEqual([
      { ...message("b1"), messageId: "b1", conversationId: CONV_B, workspaceId: WS },
    ])
  })

  it("stamps the workspace on every row so a workspace read scopes correctly (INV-8)", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    await seedConversationMessages("ws_2", CONV_B, [message("b1")])

    expect(rowsOf(await db.conversationMessages.where("workspaceId").equals(WS).toArray())).toEqual([
      { ...message("a1"), messageId: "a1", conversationId: CONV_A, workspaceId: WS },
    ])
  })
})

describe("patchConversationMessage", () => {
  it("merges the patch onto an existing row", async () => {
    await seedConversationMessages(WS, CONV_A, [message("m1")])
    await patchConversationMessage("m1", { contentMarkdown: "edited", editedAt: "2026-07-02T10:00:00.000Z" })

    expect(rowsOf(await db.conversationMessages.toArray())).toEqual([
      {
        ...message("m1", { contentMarkdown: "edited", editedAt: "2026-07-02T10:00:00.000Z" }),
        messageId: "m1",
        conversationId: CONV_A,
        workspaceId: WS,
      },
    ])
  })

  it("is a no-op when the message isn't cached", async () => {
    await patchConversationMessage("m_absent", { contentMarkdown: "edited" })
    expect(await db.conversationMessages.toArray()).toEqual([])
  })

  it("does not write when the resolved patch changes nothing — a duplicate reaction", async () => {
    // A re-delivered reaction resolves to `{}`; writing it anyway would bump
    // `_cachedAt` and wake every liveQuery watching this conversation.
    await seedConversationMessages(WS, CONV_A, [message("m1", { reactions: { "👍": ["usr_1"] } })])
    // Age the stamp so any write is visible: seeding and patching can land in the
    // same millisecond, which would make an identical `_cachedAt` prove nothing.
    await db.conversationMessages.update("m1", { _cachedAt: 1 })
    const before = await db.conversationMessages.get("m1")

    await patchConversationMessage("m1", (row) => {
      const reactions = { ...row.reactions }
      if ((reactions["👍"] ?? []).includes("usr_1")) return {}
      reactions["👍"] = [...(reactions["👍"] ?? []), "usr_1"]
      return { reactions }
    })

    expect(await db.conversationMessages.get("m1")).toEqual(before)
  })

  it("does not write when every patched field already holds that value", async () => {
    await seedConversationMessages(WS, CONV_A, [message("m1")])
    await db.conversationMessages.update("m1", { _cachedAt: 1 })
    const before = await db.conversationMessages.get("m1")

    await patchConversationMessage("m1", { contentMarkdown: "body m1", editedAt: null })

    expect(await db.conversationMessages.get("m1")).toEqual(before)
  })
})

describe("useConversationBackfillMessages", () => {
  it("returns the conversation's rows live when enabled", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    await seedConversationMessages(WS, CONV_B, [message("b1")])
    const { result } = renderHook(() => useConversationBackfillMessages(CONV_A, { enabled: true }))

    await waitFor(() => expect(result.current.map((row) => row.messageId)).toEqual(["a1"]))
  })

  it("returns the primed snapshot in its FIRST render, before the live query emits", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1"), message("a2")])
    await primeConversationMessages([CONV_A])

    const renders: string[][] = []
    const { result } = renderHook(() => {
      const rows = useConversationBackfillMessages(CONV_A, { enabled: true })
      renders.push(rows.map((row) => row.messageId))
      return rows
    })

    // The frame the board reveals in — no waiting, no second render.
    expect(renders[0]).toEqual(["a1", "a2"])
    // The live query then takes ownership of the value.
    await waitFor(() => expect(result.current.map((row) => row.messageId)).toEqual(["a1", "a2"]))
  })

  it("refreshes the snapshot from the live query, so a later mount is warm with the newer rows", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    await primeConversationMessages([CONV_A])
    const first = renderHook(() => useConversationBackfillMessages(CONV_A, { enabled: true }))
    await seedConversationMessages(WS, CONV_A, [message("a1"), message("a2")])
    await waitFor(() => expect(first.result.current.map((row) => row.messageId)).toEqual(["a1", "a2"]))
    first.unmount()

    const renders: string[][] = []
    renderHook(() => {
      const rows = useConversationBackfillMessages(CONV_A, { enabled: true })
      renders.push(rows.map((row) => row.messageId))
      return rows
    })

    expect(renders[0]).toEqual(["a1", "a2"])
  })

  it("returns [] and registers no Dexie subscription when disabled", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConversationBackfillMessages(CONV_A, { enabled: false })
    })

    await waitFor(() => expect(result.current).toEqual([]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rendersAfterMount = renders

    // A write the disabled querier would have observed had it touched the table.
    await seedConversationMessages(WS, CONV_A, [message("a1", { contentMarkdown: "edited" }), message("a2")])
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(result.current).toEqual([])
    expect(renders).toBe(rendersAfterMount)
  })
})

describe("primeConversationMessages", () => {
  it("fills only ABSENT keys — a conversation the live query already owns is not clobbered", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    await primeConversationMessages([CONV_A])
    // A later write that the primed snapshot must NOT pick up: the live query owns
    // this conversation now, and a re-prime is always the older read.
    await seedConversationMessages(WS, CONV_A, [message("a1", { contentMarkdown: "edited" }), message("a2")])

    await primeConversationMessages([CONV_A, CONV_B])

    const renders: string[][] = []
    renderHook(() => {
      const rows = useConversationBackfillMessages(CONV_A, { enabled: true })
      renders.push(rows.map((row) => row.contentMarkdown))
      return rows
    })
    // First frame is the snapshot from the first prime, untouched by the second.
    expect(renders[0]).toEqual(["body a1"])
    // And the conversation with no rows still counts as primed (read, not found).
    expect(conversationMessagesPrimed([CONV_A, CONV_B])).toBe(true)
  })

  it("reports unprimed conversations as not primed", async () => {
    await primeConversationMessages([CONV_A])
    expect(conversationMessagesPrimed([CONV_A])).toBe(true)
    expect(conversationMessagesPrimed([CONV_A, CONV_B])).toBe(false)
  })
})

describe("useBoardBackfillPrimed", () => {
  it("is false until the prime resolves, then true", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1")])
    const { result } = renderHook(() => useBoardBackfillPrimed([CONV_A]))

    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
  })

  it("is true with no conversations to prime — an empty feed gates on nothing", () => {
    const { result } = renderHook(() => useBoardBackfillPrimed([]))
    expect(result.current).toBe(true)
  })
})

describe("pruneConversationMessagesToMembership", () => {
  it("drops rows the new membership no longer names, keeping the rest", async () => {
    await seedConversationMessages(WS, CONV_A, [message("m1"), message("r_old"), message("r_moved")])
    await seedConversationMessages(WS, CONV_B, [message("b1")])

    await pruneConversationMessagesToMembership(CONV_A, new Set(["m1", "r_old"]))

    expect(rowsOf(await db.conversationMessages.toArray())).toEqual([
      { ...message("b1"), messageId: "b1", conversationId: CONV_B, workspaceId: WS },
      { ...message("m1"), messageId: "m1", conversationId: CONV_A, workspaceId: WS },
      { ...message("r_old"), messageId: "r_old", conversationId: CONV_A, workspaceId: WS },
    ])
  })
})

describe("deleteConversationMessages", () => {
  it("clears the conversation's rows and no others", async () => {
    await seedConversationMessages(WS, CONV_A, [message("a1"), message("a2")])
    await seedConversationMessages(WS, CONV_B, [message("b1")])

    await deleteConversationMessages(CONV_A)

    expect(rowsOf(await db.conversationMessages.toArray())).toEqual([
      { ...message("b1"), messageId: "b1", conversationId: CONV_B, workspaceId: WS },
    ])
  })
})
