import { describe, test, expect } from "bun:test"
import { renderStable, renderDelta, buildSnapshot } from "./render"
import type { LastRenderedSnapshot, RenderableMessage, SummaryInput } from "./types"
import { diffInputs } from "./diff"

function item(overrides: Partial<RenderableMessage>): RenderableMessage {
  return {
    messageId: "msg_a",
    authorId: "usr_1",
    authorName: "Alice",
    contentMarkdown: "hello",
    createdAt: "2026-04-22T09:00:00Z",
    editedAt: null,
    sequence: 1n,
    ...overrides,
  }
}

function input(overrides: Partial<SummaryInput>): SummaryInput {
  return {
    messageId: "msg_a",
    contentFingerprint: "sha256:aaa",
    editedAt: null,
    deleted: false,
    ...overrides,
  }
}

describe("renderStable", () => {
  test("produces identical output across calls with the same inline items (cache-prefix stability)", () => {
    const items = [item({ messageId: "msg_a" }), item({ messageId: "msg_b", contentMarkdown: "second" })]
    const first = renderStable({ preamble: "p", inlineItems: items, refLabel: "thread:stream_x" })
    const second = renderStable({ preamble: "p", inlineItems: items, refLabel: "thread:stream_x" })
    expect(first).toBe(second)
  })

  test("rendering the same inline items again after an edit keeps the stable region byte-identical", () => {
    // First render: original content.
    const first = renderStable({
      preamble: "p",
      inlineItems: [item({ messageId: "msg_a", contentMarkdown: "first version" })],
      refLabel: "thread:stream_x",
    })
    // Later on the source message is edited — but the stable region is
    // supposed to keep rendering the SAME original inline content. Callers
    // must not re-render with the edited text in the stable region.
    const staleReRender = renderStable({
      preamble: "p",
      inlineItems: [item({ messageId: "msg_a", contentMarkdown: "first version" })],
      refLabel: "thread:stream_x",
    })
    expect(staleReRender).toBe(first)
  })

  test("picks the summary path when summaryText is provided", () => {
    const rendered = renderStable({
      preamble: "discuss",
      summaryText: "A short summary [msg_a].",
      refLabel: "thread:stream_x",
    })
    expect(rendered).toContain("A short summary [msg_a]")
    expect(rendered).not.toContain("Messages (chronological)")
  })

  test("renders attachment metadata under each message that has attachments", () => {
    // Without this the Discuss-with-Ariadne trace shows text-only messages
    // even when the focal message had a PDF attached, which makes the model
    // (and the human reading the trace) think nothing was shared.
    const rendered = renderStable({
      preamble: "p",
      inlineItems: [
        item({
          messageId: "msg_a",
          contentMarkdown: "see attached",
          attachments: [{ id: "att_1", filename: "spec.pdf", mimeType: "application/pdf", sizeBytes: 12345 }],
        }),
        item({ messageId: "msg_b", contentMarkdown: "no attachments here" }),
      ],
      refLabel: "thread:stream_x",
    })
    expect(rendered).toContain("[att_1] spec.pdf")
    expect(rendered).toContain("application/pdf")
    expect(rendered).toContain("12345 bytes")
    // Messages without attachments should NOT get an empty attachments line.
    expect(rendered).not.toMatch(/no attachments here\n\s+Attachments:/)
  })
})

describe("renderDelta", () => {
  test("returns empty string when nothing drifted", () => {
    const prev: LastRenderedSnapshot = { renderedAt: "t0", items: [input({})], tailMessageId: "msg_a" }
    const diff = diffInputs([input({})], prev)
    const out = renderDelta({
      diff,
      currentByMessageId: new Map([["msg_a", item({})]]),
    })
    expect(out).toBe("")
  })

  test("lists appends, edits and deletes under distinct sections", () => {
    const prev: LastRenderedSnapshot = {
      renderedAt: "t0",
      items: [input({ messageId: "msg_a" }), input({ messageId: "msg_b", contentFingerprint: "sha256:b1" })],
      tailMessageId: "msg_b",
    }
    const currentInputs = [
      input({ messageId: "msg_a" }),
      input({ messageId: "msg_b", contentFingerprint: "sha256:b2", editedAt: "2026-04-22T09:10:00Z" }),
      input({ messageId: "msg_c", contentFingerprint: "sha256:c1" }),
    ]
    // msg_d was present in a different (non-prev) state; not tested here.
    const diff = diffInputs(currentInputs, prev)
    // Simulate a delete by removing msg_c from "current" vs a snapshot with it:
    const prevWithC: LastRenderedSnapshot = {
      ...prev,
      items: [...prev.items, input({ messageId: "msg_c", contentFingerprint: "sha256:c1" })],
    }
    const diff2 = diffInputs([input({ messageId: "msg_a" })], prevWithC)

    const combined = renderDelta({
      diff: {
        appends: diff.appends,
        edits: diff.edits,
        deletes: diff2.deletes,
      },
      currentByMessageId: new Map([
        ["msg_a", item({ messageId: "msg_a" })],
        ["msg_b", item({ messageId: "msg_b", contentMarkdown: "new body" })],
        ["msg_c", item({ messageId: "msg_c", contentMarkdown: "three" })],
      ]),
    })

    expect(combined).toContain("Appended messages")
    expect(combined).toContain("msg_c")
    expect(combined).toContain("Edited messages")
    expect(combined).toContain("msg_b")
    expect(combined).toContain("Deleted messages")
  })
})

describe("renderStable with a viewport span", () => {
  const items = [
    item({ messageId: "msg_a" }),
    item({ messageId: "msg_b" }),
    item({ messageId: "msg_c", contentMarkdown: "seen one" }),
    item({ messageId: "msg_d", contentMarkdown: "seen two" }),
    item({ messageId: "msg_e" }),
  ]

  test("splits the window around the visible span and marks each visible message", () => {
    const out = renderStable({
      preamble: "",
      inlineItems: items,
      refLabel: "viewport:stream_x",
      visibleMessageIds: ["msg_c", "msg_d"],
    })
    const [before, span, after] = out.split(/\n\n(?=Messages before|On screen|Messages after)/).slice(1)
    expect(before).toContain("Messages before what was on screen (2, chronological):")
    expect(before).toContain("- [msg_a]")
    expect(before).toContain("- [msg_b]")
    expect(span).toContain(
      "On screen when the aside was opened (2 visible, chronological; `►` marks a visible message):"
    )
    expect(span).toContain("► [msg_c]")
    expect(span).toContain("► [msg_d]")
    expect(after).toContain("Messages after what was on screen (1, chronological):")
    expect(after).toContain("- [msg_e]")
    expect(out).not.toContain("Messages (chronological)")
  })

  test("a non-visible message inside the span stays unmarked", () => {
    const out = renderStable({
      preamble: "",
      inlineItems: items,
      refLabel: "viewport:stream_x",
      visibleMessageIds: ["msg_b", "msg_d"],
    })
    expect(out).toContain("(2 visible")
    expect(out).toContain("► [msg_b]")
    expect(out).toContain("- [msg_c]")
    expect(out).toContain("► [msg_d]")
  })

  test("omits the before/after sections when the span reaches the window edges", () => {
    const out = renderStable({
      preamble: "",
      inlineItems: items,
      refLabel: "viewport:stream_x",
      visibleMessageIds: items.map((i) => i.messageId),
    })
    expect(out).not.toContain("Messages before what was on screen")
    expect(out).not.toContain("Messages after what was on screen")
    expect(out).toContain("(5 visible")
  })

  test("falls back to the plain list when none of the visible ids are in the window", () => {
    const out = renderStable({
      preamble: "",
      inlineItems: items,
      refLabel: "viewport:stream_x",
      visibleMessageIds: ["msg_phantom"],
    })
    expect(out).toContain("Messages (chronological)")
    expect(out).not.toContain("On screen when the aside was opened")
  })

  test("is byte-identical across renders of the same span (cache-prefix stability)", () => {
    const render = () =>
      renderStable({ preamble: "p", inlineItems: items, refLabel: "viewport:stream_x", visibleMessageIds: ["msg_c"] })
    expect(render()).toBe(render())
  })
})

describe("buildSnapshot", () => {
  test("captures inputs verbatim and derives tail from the trailing item", () => {
    const inputs = [input({ messageId: "msg_a" }), input({ messageId: "msg_b" })]
    const snap = buildSnapshot(inputs, "msg_b")
    expect(snap.items).toEqual(inputs)
    expect(snap.tailMessageId).toBe("msg_b")
    expect(snap.renderedAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })
})
