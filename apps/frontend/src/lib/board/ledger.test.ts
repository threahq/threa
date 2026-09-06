import { describe, expect, it } from "vitest"

import type { AttachmentSummary, LinkPreviewSummary } from "@threahq/types"

import type { CachedEvent } from "@/db"
import { formatFireTime } from "@/lib/dates"
import type { BoardEventRow } from "./board-event-rows"
import {
  coalesceLedgerItems,
  leadLine,
  ledgerEventContent,
  linkLabel,
  rowArtifacts,
  unreadMass,
  type EffectiveUnreadCtx,
  type UnreadCandidate,
} from "./ledger"

describe("leadLine", () => {
  it("returns plain text unchanged", () => {
    expect(leadLine("Shipping the ledger today", 80)).toBe("Shipping the ledger today")
  })

  it("truncates with an ellipsis only when longer than maxChars", () => {
    expect(leadLine("abcdefghij", 5)).toBe("abcde…")
    expect(leadLine("abcde", 5)).toBe("abcde")
  })

  it("drops heading markers", () => {
    expect(leadLine("## Decision\n\nWe ship", 80)).toBe("Decision")
  })

  it("uses the code inside a leading fence — the fence markers are removed block-wise", () => {
    expect(leadLine("```ts\nconst a = 1\n```\nafter", 80)).toBe("const a = 1")
  })

  it("keeps fence content verbatim — a code comment is not a heading", () => {
    expect(leadLine("```py\n# load the frame\ndf = 1\n```", 80)).toBe("# load the frame")
  })

  it("keeps a shell redirect inside a fence — not a blockquote", () => {
    expect(leadLine("```sh\n> out.txt\n```", 80)).toBe("> out.txt")
  })

  it("resolves emoji shortcodes when a converter is passed", () => {
    const toEmoji = (shortcode: string) => (shortcode === "tada" ? "🎉" : null)
    expect(leadLine(":tada: shipped", 80, toEmoji)).toBe("🎉 shipped")
    expect(leadLine(":nope: shipped", 80, toEmoji)).toBe(":nope: shipped")
    expect(leadLine(":tada: shipped", 80)).toBe(":tada: shipped")
  })

  it("drops blockquote markers", () => {
    expect(leadLine("> quoted thought", 80)).toBe("quoted thought")
  })

  it("renders mention markdown as @name", () => {
    expect(leadLine("[@alice](user:usr_1) can you look?", 80)).toBe("@alice can you look?")
  })

  it("skips a divider and an alt-less image line", () => {
    expect(leadLine("---\n![](https://x.test/a.png)\nreal content", 80)).toBe("real content")
  })

  it("keeps image alt text when there is any", () => {
    expect(leadLine("![the chart](https://x.test/a.png)", 80)).toBe("the chart")
  })

  it("returns an empty string when nothing survives the strip", () => {
    expect(leadLine("", 80)).toBe("")
    expect(leadLine("---\n![](https://x.test/a.png)", 80)).toBe("")
  })

  it("skips a line that only the per-line strip empties (a doubly-quoted divider)", () => {
    expect(leadLine("> > ---\nreal content", 80)).toBe("real content")
    expect(leadLine("> > ![](u)\nreal", 80)).toBe("real")
  })

  it("cuts on code points, never mid-emoji", () => {
    const out = leadLine(`${"a".repeat(39)}😀 rest`, 40)
    expect(out).toBe(`${"a".repeat(39)}😀…`)
    expect([...out].every((c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff)).toBe(true)
  })
})

describe("unreadMass", () => {
  const row = (id: string, authorId: string, chars: number): UnreadCandidate => ({
    id,
    authorId,
    createdAt: "2026-06-22T12:00:00.000Z",
    contentMarkdown: "x".repeat(chars),
  })
  const ctx = (unread: string[]): EffectiveUnreadCtx => ({
    currentUserId: "usr_me",
    fallbackStreamId: "stream_1",
    state: (_streamId, messageId) => (unread.includes(messageId) ? "unread" : "read"),
  })

  it("counts the unread rows", () => {
    const rows = [row("a", "usr_other", 600), row("b", "usr_other", 600), row("c", "usr_other", 5000)]
    expect(unreadMass(rows, ctx(["a", "b"]))).toEqual({ count: 2 })
  })

  it("excludes read rows and the viewer's own messages", () => {
    const rows = [row("a", "usr_me", 5000), row("b", "usr_other", 100)]
    expect(unreadMass(rows, ctx(["a", "b"]))).toEqual({ count: 1 })
  })

  it("is zero when nothing is unread", () => {
    expect(unreadMass([row("a", "usr_other", 900)], ctx([]))).toEqual({ count: 0 })
  })

  it("resolves a row without its own stream against the fallback", () => {
    const seen: string[] = []
    unreadMass([{ ...row("a", "usr_other", 10), streamId: "thread_9" }, row("b", "usr_other", 10)], {
      currentUserId: "usr_me",
      fallbackStreamId: "stream_1",
      state: (streamId) => {
        seen.push(streamId)
        return "read"
      },
    })
    expect(seen).toEqual(["thread_9", "stream_1"])
  })
})

const preview = (overrides: Partial<LinkPreviewSummary>): LinkPreviewSummary => ({
  id: "lp_1",
  url: "https://www.example.com/a/b",
  title: null,
  description: null,
  imageUrl: null,
  faviconUrl: null,
  siteName: null,
  contentType: "website",
  position: 0,
  ...overrides,
})

const attachment = (id: string) => ({ id }) as AttachmentSummary

describe("rowArtifacts", () => {
  it("reports nothing for a bare message", () => {
    expect(rowArtifacts({})).toEqual({ attachmentCount: 0, firstLinkLabel: null })
  })

  it("counts attachments", () => {
    expect(rowArtifacts({ attachments: [attachment("att_1"), attachment("att_2")] })).toEqual({
      attachmentCount: 2,
      firstLinkLabel: null,
    })
  })

  it("ignores stream-link previews", () => {
    expect(
      rowArtifacts({ linkPreviews: [preview({ contentType: "stream_link", url: "https://app.threa.io/s/x" })] })
    ).toEqual({
      attachmentCount: 0,
      firstLinkLabel: null,
    })
  })

  it.each([
    ["message_link", "message"],
    ["memo_link", "memo"],
    ["conversation_link", "conversation"],
    ["delegation_link", "delegation"],
  ] as const)("labels an in-app %s preview with its kind noun", (contentType, noun) => {
    expect(
      rowArtifacts({ linkPreviews: [preview({ contentType, url: "https://app.threa.io/x", title: null })] })
        .firstLinkLabel
    ).toBe(noun)
  })

  it("falls back to 'link' for an in-app kind with no noun mapped", () => {
    // stream_link is the only in-app type outside the noun map; rowArtifacts
    // filters it out, so the fallback is exercised through linkLabel directly.
    expect(linkLabel(preview({ contentType: "stream_link", url: "https://app.threa.io/x" }))).toBe("link")
  })

  it("uses a short title", () => {
    expect(rowArtifacts({ linkPreviews: [preview({ title: "Postgres upsert docs" })] }).firstLinkLabel).toBe(
      "Postgres upsert docs"
    )
  })

  it("falls back to the www-stripped hostname for a long title", () => {
    expect(
      rowArtifacts({
        linkPreviews: [preview({ title: "A very long link title that will not fit in the row" })],
      }).firstLinkLabel
    ).toBe("example.com")
  })

  it("takes the first non-stream preview", () => {
    expect(
      rowArtifacts({
        linkPreviews: [
          preview({ id: "lp_0", contentType: "stream_link" }),
          preview({ id: "lp_1", title: "Second", url: "https://docs.test/x" }),
        ],
      }).firstLinkLabel
    ).toBe("Second")
  })
})

type Item = { kind: "message" | "event"; id: string }
const msg = (id: string): Item => ({ kind: "message", id })
const evt = (id: string): Item => ({ kind: "event", id })

describe("coalesceLedgerItems", () => {
  it("passes messages through", () => {
    expect(coalesceLedgerItems([msg("m1"), msg("m2")])).toEqual([msg("m1"), msg("m2")])
  })

  it("leaves a lone event alone", () => {
    expect(coalesceLedgerItems([msg("m1"), evt("e1"), msg("m2")])).toEqual([msg("m1"), evt("e1"), msg("m2")])
  })

  it("folds a run of three", () => {
    expect(coalesceLedgerItems([msg("m1"), evt("e1"), evt("e2"), evt("e3"), msg("m2")])).toEqual([
      msg("m1"),
      { kind: "event-group", events: [evt("e1"), evt("e2"), evt("e3")] },
      msg("m2"),
    ])
  })

  it("folds two runs separately", () => {
    expect(coalesceLedgerItems([evt("e1"), evt("e2"), msg("m1"), evt("e3"), evt("e4")])).toEqual([
      { kind: "event-group", events: [evt("e1"), evt("e2")] },
      msg("m1"),
      { kind: "event-group", events: [evt("e3"), evt("e4")] },
    ])
  })

  it("returns an empty list unchanged", () => {
    expect(coalesceLedgerItems([])).toEqual([])
  })
})

describe("ledgerEventContent", () => {
  const ctx = { traceUrl: (sessionId: string) => `/w/ws_1/trace/${sessionId}` }

  function event(eventType: string, payload: unknown): CachedEvent {
    return {
      id: "evt_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      sequence: "1",
      _sequenceNum: 1,
      eventType: eventType as CachedEvent["eventType"],
      payload: payload as CachedEvent["payload"],
      actorId: null,
      actorType: null,
      createdAt: "2026-07-28T10:00:00.000Z",
      _cachedAt: 1,
    }
  }

  it("names the persona, its steps and duration, and links the trace", () => {
    const row: BoardEventRow = {
      kind: "session",
      key: "slot_1",
      sortMs: 0,
      streamId: "stream_1",
      events: [
        event("agent_session:started", { sessionId: "sess_1", personaName: "Ariadne" }),
        event("agent_session:completed", { sessionId: "sess_1", stepCount: 41, messageCount: 2, duration: 720_000 }),
      ],
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "slot_1",
      kind: "session",
      label: "Ariadne",
      meta: "41 steps · 12m 0s",
      href: "/w/ws_1/trace/sess_1",
    })
  })

  it("reads a still-running session as running", () => {
    const row: BoardEventRow = {
      kind: "session",
      key: "slot_1",
      sortMs: 0,
      streamId: "stream_1",
      events: [event("agent_session:started", { sessionId: "sess_1", personaName: "Ariadne" })],
    }
    expect(ledgerEventContent(row, ctx).meta).toBe("running")
  })

  it("carries a capture's TITLE and its memo descriptor (no href — the row previews in place)", () => {
    const row: BoardEventRow = {
      kind: "memo",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("memos:captured", {
        conversationId: "conv_1",
        memos: [
          {
            memoId: "memo_9",
            title: "Postgres upserts need the index",
            knowledgeType: "fact",
            sourceMessageIds: ["msg_1"],
          },
        ],
      }),
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "evt_1",
      kind: "memo",
      label: "Memo: Postgres upserts need the index",
      memo: { memoId: "memo_9", title: "Postgres upserts need the index" },
    })
  })

  it("leaves a multi-memo capture without a preview target (no single memo to open)", () => {
    const row: BoardEventRow = {
      kind: "memo",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("memos:captured", {
        conversationId: "conv_1",
        memos: [
          { memoId: "memo_1", title: "One", knowledgeType: "fact", sourceMessageIds: [] },
          { memoId: "memo_2", title: "Two", knowledgeType: "fact", sourceMessageIds: [] },
        ],
      }),
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "evt_1",
      kind: "memo",
      label: "Memo: One, Two",
      memo: undefined,
    })
  })

  it("marks a cancelled follow-up cancelled and never links it", () => {
    const row: BoardEventRow = {
      kind: "followUp",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      cancelled: true,
      event: event("agent:follow_up_scheduled", {
        followUpId: "fu_1",
        note: "Chase the vendor quote",
        scheduledFor: "2026-08-01T09:00:00.000Z",
      }),
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "evt_1",
      kind: "followUp",
      label: "Follow-up: Chase the vendor quote",
      meta: "cancelled",
    })
  })

  it("renders a fired follow-up's schedule as an absolute time, never a clamped countdown", () => {
    const scheduledFor = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const row: BoardEventRow = {
      kind: "followUp",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      cancelled: false,
      event: event("agent:follow_up_scheduled", {
        followUpId: "fu_1",
        note: "Chase the vendor quote",
        scheduledFor: scheduledFor.toISOString(),
      }),
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "evt_1",
      kind: "followUp",
      label: "Follow-up: Chase the vendor quote",
      meta: `fires ${formatFireTime(scheduledFor)}`,
    })
  })

  it("labels an unclaimed delegation with the shared Open label", () => {
    const row: BoardEventRow = {
      kind: "delegation",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("delegation:created", {
        delegationId: "dlg_1",
        title: "Migrate the index",
        brief: "…",
        contextRefs: [],
        sourceConversationId: "conv_1",
      }),
    }
    expect(ledgerEventContent(row, ctx)?.meta).toBe("Open")
  })

  it.each([
    ["claim_expired", "Claim expired · Open again"],
    ["claim_released", "Claim released · Open again"],
    ["requeued", "Requeued · Open"],
    [undefined, "Open"],
  ] as const)("carries the delegation's %s reopen reason", (reason, label) => {
    const row: BoardEventRow = {
      kind: "delegation",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("delegation:created", { delegationId: "dlg_1", title: "Migrate", brief: "…", contextRefs: [] }),
      statusPatch: { delegationId: "dlg_1", status: "open", reason },
    }
    expect(ledgerEventContent(row, ctx).meta).toBe(label)
  })

  it("keeps historical expired delegations active in the compact ledger", () => {
    const row: BoardEventRow = {
      kind: "delegation",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("delegation:created", { delegationId: "dlg_1", title: "Migrate", brief: "…", contextRefs: [] }),
      statusPatch: { delegationId: "dlg_1", status: "expired" },
    }
    expect(ledgerEventContent(row, ctx).meta).toBe("Claim expired")
  })

  it("carries a delegation's title and its latest status", () => {
    const row: BoardEventRow = {
      kind: "delegation",
      key: "evt_1",
      sortMs: 0,
      streamId: "stream_1",
      event: event("delegation:created", {
        delegationId: "dlg_1",
        title: "Migrate the index",
        brief: "…",
        contextRefs: [],
        sourceConversationId: "conv_1",
      }),
      statusPatch: { delegationId: "dlg_1", status: "claimed" },
    }
    expect(ledgerEventContent(row, ctx)).toEqual({
      key: "evt_1",
      kind: "delegation",
      label: "Delegation: Migrate the index",
      meta: "Claimed",
    })
  })
})
