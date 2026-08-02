import { describe, expect, it } from "vitest"

import type { AttachmentSummary, LinkPreviewSummary } from "@threa/types"

import { coalesceLedgerItems, estimateReadingMinutes, leadLine, linkLabel, rowArtifacts } from "./ledger"

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

describe("estimateReadingMinutes", () => {
  it("maps character counts to whole minutes", () => {
    expect(estimateReadingMinutes(0)).toBe(0)
    expect(estimateReadingMinutes(1)).toBe(1)
    expect(estimateReadingMinutes(1100)).toBe(1)
    expect(estimateReadingMinutes(1101)).toBe(2)
    expect(estimateReadingMinutes(12_000)).toBe(11)
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
