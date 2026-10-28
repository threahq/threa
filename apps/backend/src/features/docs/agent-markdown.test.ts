import { describe, expect, test } from "bun:test"
import type { JSONContent } from "@threahq/types"
import {
  buildContent,
  deleteSection,
  insertSection,
  moveSection,
  normalizeTrailingWs,
  renderWithMarkers,
  resolveEdits,
  stripMarkers,
  type NextSection,
} from "./agent-markdown"
import { projectDoc } from "./projection"

const id = (n: number) => `blk_${String(n).padStart(26, "0")}`
const paragraph = (value: string, n: number): JSONContent => ({
  type: "paragraph",
  attrs: { blockId: id(n) },
  content: [{ type: "text", text: value }],
})

const body: JSONContent = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2, blockId: id(1) }, content: [{ type: "text", text: "Rotation" }] },
    paragraph("AWS key is live", 2),
    paragraph("GCP key is live", 3),
  ],
}
const sections = projectDoc(body, "stream_agent_markdown_test").sections

function minter() {
  let n = 100
  return () => id(++n)
}

function changedMarkdown(next: NextSection[]) {
  return next.map(({ blockId, markdown, changed }) => ({ blockId, markdown, changed }))
}

describe("agent markdown", () => {
  test("should render one marker line before each block and strip markers back out", () => {
    const rendered = renderWithMarkers(sections)

    expect({ rendered, stripped: stripMarkers(rendered), trimmed: normalizeTrailingWs("a  \nb\t\nc") }).toEqual({
      rendered: `<!-- ${id(1)} -->\n## Rotation\n\n<!-- ${id(2)} -->\nAWS key is live\n\n<!-- ${id(3)} -->\nGCP key is live`,
      stripped: "## Rotation\n\nAWS key is live\n\nGCP key is live",
      trimmed: "a\nb\nc",
    })
  })

  test("should replace an exact match, tolerating trailing whitespace and markers in the edit", () => {
    const result = resolveEdits(sections, [
      { old: "AWS key is live", new: "AWS key is revoked" },
      { old: `<!-- ${id(3)} -->\nGCP key is live   `, new: "GCP key is revoked  " },
    ])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(1), markdown: "## Rotation", changed: false },
      { blockId: id(2), markdown: "AWS key is revoked", changed: true },
      { blockId: id(3), markdown: "GCP key is revoked", changed: true },
    ])
  })

  test("should refuse an anchor that matches two blocks with the whole doc as scope", () => {
    expect(resolveEdits(sections, [{ old: "key is live", new: "key is gone" }])).toEqual({
      ok: false,
      refusal: { reason: "ambiguous", editIndex: 0, scope: { markdown: renderWithMarkers(sections) } },
    })
  })

  test("should resolve an anchor scoped to one block even when it occurs in another", () => {
    const result = resolveEdits(sections, [{ blockId: id(3), old: "key is live", new: "key is gone" }])

    expect(result.ok && changedMarkdown(result.sections).filter((s) => s.changed)).toEqual([
      { blockId: id(3), markdown: "GCP key is gone", changed: true },
    ])
  })

  test("should refuse a missing scoped anchor with only that block, and abort on any failing edit", () => {
    expect(
      resolveEdits(sections, [
        { old: "AWS key is live", new: "AWS key is revoked" },
        { blockId: id(3), old: "Azure", new: "Azure revoked" },
      ])
    ).toEqual({
      ok: false,
      refusal: {
        reason: "not_found",
        editIndex: 1,
        scope: { blockId: id(3), markdown: renderWithMarkers([sections[2]]) },
      },
    })
  })

  test("should never match across two blocks and refuse an unknown block", () => {
    expect({
      spanning: resolveEdits(sections, [{ old: "Rotation\n\nAWS", new: "x" }]),
      unknown: resolveEdits(sections, [{ blockId: id(9), old: "x", new: "y" }]),
    }).toEqual({
      spanning: {
        ok: false,
        refusal: { reason: "not_found", editIndex: 0, scope: { markdown: renderWithMarkers(sections) } },
      },
      unknown: {
        ok: false,
        refusal: { reason: "unknown_block", editIndex: 0, scope: { markdown: renderWithMarkers(sections) } },
      },
    })
  })

  test("should keep unchanged nodes verbatim, keep the id on the first block of a split, and drop an emptied block", () => {
    const result = resolveEdits(sections, [
      { old: "AWS key is live", new: "AWS key is live\n\nAWS key rotated" },
      { old: "GCP key is live", new: "" },
    ])
    if (!result.ok) throw new Error("expected the edits to resolve")

    const content = buildContent(result.sections, body, minter())

    expect({ heading: content.content?.[0] === body.content?.[0], content }).toEqual({
      heading: true,
      content: {
        type: "doc",
        content: [
          body.content![0],
          paragraph("AWS key is live", 2),
          { type: "paragraph", attrs: { blockId: id(101) }, content: [{ type: "text", text: "AWS key rotated" }] },
        ],
      },
    })
  })

  test("should insert after a block or at the start, move, and delete", () => {
    const mint = minter()
    const order = (result: ReturnType<typeof moveSection>) =>
      result.ok ? result.sections.map((s) => s.blockId) : result.refusal.reason
    const inserted = insertSection(sections, { after: id(1), markdown: `<!-- ${id(7)} -->\nNew row` }, mint)

    expect({
      inserted: inserted.ok && changedMarkdown(inserted.sections),
      atStart: order(insertSection(sections, { after: "start", markdown: "Top" }, mint)),
      moved: order(moveSection(sections, { blockId: id(3), after: "start" })),
      movedAfter: order(moveSection(sections, { blockId: id(1), after: id(3) })),
      deleted: order(deleteSection(sections, { blockId: id(2) })),
      unknownInsert: order(insertSection(sections, { after: id(9), markdown: "x" }, mint)),
      unknownMove: order(moveSection(sections, { blockId: id(1), after: id(9) })),
      unknownDelete: order(deleteSection(sections, { blockId: id(9) })),
    }).toEqual({
      inserted: [
        { blockId: id(1), markdown: "## Rotation", changed: false },
        { blockId: id(101), markdown: "New row", changed: true },
        { blockId: id(2), markdown: "AWS key is live", changed: false },
        { blockId: id(3), markdown: "GCP key is live", changed: false },
      ],
      atStart: [id(102), id(1), id(2), id(3)],
      moved: [id(3), id(1), id(2)],
      movedAfter: [id(2), id(3), id(1)],
      deleted: [id(1), id(3)],
      unknownInsert: "unknown_block",
      unknownMove: "unknown_block",
      unknownDelete: "unknown_block",
    })
  })

  test("should mark a real move for reinsertion and a move into the same place as a no-op", () => {
    const reinserted = (result: ReturnType<typeof moveSection>) => (result.ok ? (result.reinserted ?? null) : "refused")

    expect({
      moved: reinserted(moveSection(sections, { blockId: id(1), after: id(3) })),
      samePlace: reinserted(moveSection(sections, { blockId: id(2), after: id(1) })),
      ontoItself: reinserted(moveSection(sections, { blockId: id(2), after: id(2) })),
    }).toEqual({ moved: id(1), samePlace: null, ontoItself: null })
  })

  test("should keep trailing whitespace on the lines of an edited block the edit does not touch", () => {
    const code = { blockId: id(5), markdown: "```py\nx = 1   \ny = 2\n```", contentJson: paragraph("", 5) }

    const result = resolveEdits([code], [{ old: "y = 2", new: "y = 3" }])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(5), markdown: "```py\nx = 1   \ny = 3\n```", changed: true },
    ])
  })

  test("should match an old with surrounding newlines, CRLF or NBSP when the exact text finds nothing", () => {
    const edited = (old: string, replacement: string) => {
      const result = resolveEdits(sections, [{ old, new: replacement }])
      return result.ok ? changedMarkdown(result.sections).filter((s) => s.changed) : result.refusal.reason
    }

    expect({
      trailingNewline: edited("AWS key is live\n", "AWS key is revoked\n"),
      leadingBlankLine: edited("\n\nGCP key is live", "\n\nGCP key is revoked"),
      crlf: edited("## Rotation\r\n", "## Rotated\r\n"),
      nbsp: edited("AWS key is live\u00a0", "AWS key is gone"),
    }).toEqual({
      trailingNewline: [{ blockId: id(2), markdown: "AWS key is revoked", changed: true }],
      leadingBlankLine: [{ blockId: id(3), markdown: "GCP key is revoked", changed: true }],
      crlf: [{ blockId: id(1), markdown: "## Rotated", changed: true }],
      nbsp: [{ blockId: id(2), markdown: "AWS key is gone", changed: true }],
    })
  })

  test("should match a hard break written without its backslash and write the new line break as a hard break", () => {
    const poem = { blockId: id(6), markdown: "roses are red\\\nviolets are blue", contentJson: paragraph("", 6) }

    const result = resolveEdits([poem], [{ old: "roses are red\nviolets are blue", new: "roses are red\nsky is blue" }])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(6), markdown: "roses are red\\\nsky is blue", changed: true },
    ])
  })

  test("should keep a blank line the replacement adds beyond the newline the old dropped", () => {
    const result = resolveEdits(sections, [{ old: "AWS key is live\n", new: "AWS key is live\n\nRotate it" }])

    expect(result.ok && changedMarkdown(result.sections).filter((s) => s.changed)).toEqual([
      { blockId: id(2), markdown: "AWS key is live\n\nRotate it", changed: true },
    ])
  })

  test("should match each hard break on its own when the old also spans a plain line break", () => {
    const list = { blockId: id(9), markdown: "- first\\\nsecond\n- third", contentJson: paragraph("", 9) }

    const result = resolveEdits([list], [{ old: "first\nsecond\n- third", new: "first\nsecond\n- 3rd" }])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(9), markdown: "- first\\\nsecond\n- 3rd", changed: true },
    ])
  })

  test("should keep the replacement's line breaks literal when its shape differs from the matched old", () => {
    const poem = { blockId: id(6), markdown: "roses are red\\\nviolets are blue", contentJson: paragraph("", 6) }

    const result = resolveEdits([poem], [{ old: "roses are red\nviolets are blue", new: "roses\nare\nred" }])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(6), markdown: "roses\nare\nred", changed: true },
    ])
  })

  test("should refuse as ambiguous when a fallback matches twice", () => {
    expect(resolveEdits(sections, [{ old: "key is live\n", new: "key is gone" }])).toEqual({
      ok: false,
      refusal: { reason: "ambiguous", editIndex: 0, scope: { markdown: renderWithMarkers(sections) } },
    })
  })

  test("should prefer the exact match over a fallback when the exact text occurs once", () => {
    const blocks = [
      { blockId: id(7), markdown: "a\n\nb", contentJson: paragraph("", 7) },
      { blockId: id(8), markdown: "a", contentJson: paragraph("", 8) },
    ]

    const result = resolveEdits(blocks, [{ old: "a\n", new: "c\n" }])

    expect(result.ok && changedMarkdown(result.sections)).toEqual([
      { blockId: id(7), markdown: "c\n\nb", changed: true },
      { blockId: id(8), markdown: "a", changed: false },
    ])
  })

  test("should refuse as not found when no fallback matches either", () => {
    expect(resolveEdits(sections, [{ old: "\nAzure key is live\n", new: "x" }])).toEqual({
      ok: false,
      refusal: { reason: "not_found", editIndex: 0, scope: { markdown: renderWithMarkers(sections) } },
    })
  })
})
