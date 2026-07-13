import { describe, expect, test } from "bun:test"
import { PERSONA_ATTACHMENT_BLOCK_MAX_CHARS, PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS } from "../../config"
import type { PersonaAttachmentContentItem } from "../../persona-attachment-repository"
import { buildPersonaKnowledgeSection } from "./persona-knowledge"

function item(overrides: Partial<PersonaAttachmentContentItem>): PersonaAttachmentContentItem {
  return {
    attachmentId: "att_x",
    filename: "file.txt",
    position: 0,
    fullText: null,
    summary: null,
    processingStatus: "processing",
    hasExtraction: false,
    ...overrides,
  }
}

describe("buildPersonaKnowledgeSection", () => {
  test("no attachments → empty string (byte-identical no-op for the composed prompt)", () => {
    expect(buildPersonaKnowledgeSection([])).toBe("")
  })

  test("renders each file as a ### subsection in array (position) order", () => {
    const block = buildPersonaKnowledgeSection([
      item({ attachmentId: "att_1", filename: "alpha.md", fullText: "ALPHA BODY" }),
      item({ attachmentId: "att_2", filename: "beta.txt", fullText: "BETA BODY" }),
    ])

    expect(block).toContain("## Knowledge")
    expect(block).toContain("### alpha.md\n\nALPHA BODY")
    expect(block).toContain("### beta.txt\n\nBETA BODY")
    expect(block.indexOf("### alpha.md")).toBeLessThan(block.indexOf("### beta.txt"))
  })

  test("inlines full text when it fits the per-file cap", () => {
    const fullText = "F".repeat(PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS)
    const block = buildPersonaKnowledgeSection([item({ filename: "fits.txt", fullText, summary: "SHORT SUMMARY" })])

    expect(block).toContain(fullText)
    expect(block).not.toContain("SHORT SUMMARY")
  })

  test("falls back to the summary when full text exceeds the per-file cap", () => {
    const fullText = "F".repeat(PERSONA_ATTACHMENT_INLINE_FULLTEXT_MAX_CHARS + 1)
    const block = buildPersonaKnowledgeSection([item({ filename: "big.txt", fullText, summary: "GIST OF BIG" })])

    expect(block).toContain("### big.txt\n\nGIST OF BIG")
    expect(block).not.toContain(fullText)
  })

  test("emits the processing note when neither full text nor summary is available", () => {
    const block = buildPersonaKnowledgeSection([item({ filename: "pending.pdf", fullText: null, summary: null })])

    expect(block).toContain("### pending.pdf\n\n(processing — content not yet available)")
  })

  test("truncates the file that crosses the block budget with an explicit marker", () => {
    // One file whose summary alone overruns the whole block budget.
    const summary = "S".repeat(PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 500)
    const block = buildPersonaKnowledgeSection([item({ filename: "huge.txt", fullText: null, summary })])

    expect(block).toContain("…[truncated]")
    // The rendered body is bounded by the budget, not the full oversize summary.
    expect(block).not.toContain(summary)
  })

  test("budget-aware degradation: a file whose full text won't fit shows its whole summary instead", () => {
    // The first file's whole summary fits but leaves only a small remainder; the
    // second file's full text overruns it, so it degrades to its whole summary.
    const firstSummary = "C".repeat(PERSONA_ATTACHMENT_BLOCK_MAX_CHARS - 100)
    const laterFullText = "LATER_FULL_TEXT_SHOULD_NOT_APPEAR_".repeat(20)
    const block = buildPersonaKnowledgeSection([
      item({ attachmentId: "att_1", filename: "first.txt", fullText: null, summary: firstSummary }),
      item({
        attachmentId: "att_2",
        filename: "second.txt",
        fullText: laterFullText,
        summary: "SECOND SUMMARY GIST",
      }),
    ])

    // First file renders whole (untruncated); the second shows its short summary,
    // not its full text — never silently dropped.
    expect(block).not.toContain("…[truncated]")
    expect(block).toContain("### second.txt")
    expect(block).toContain("SECOND SUMMARY GIST")
    expect(block).not.toContain(laterFullText)
  })

  test("processing vs failed extractions render distinct notes (T3)", () => {
    const block = buildPersonaKnowledgeSection([
      item({
        attachmentId: "att_1",
        filename: "pending.pdf",
        fullText: null,
        summary: null,
        processingStatus: "processing",
        hasExtraction: false,
      }),
      item({
        attachmentId: "att_2",
        filename: "broken.pdf",
        fullText: null,
        summary: null,
        processingStatus: "failed",
        hasExtraction: false,
      }),
    ])

    expect(block).toContain("### pending.pdf\n\n(processing — content not yet available)")
    expect(block).toContain("### broken.pdf\n\n(extraction failed — content unavailable)")
  })

  test("a post-budget file with no summary renders the marker so it is never silently dropped", () => {
    const crossingSummary = "C".repeat(PERSONA_ATTACHMENT_BLOCK_MAX_CHARS + 1)
    const block = buildPersonaKnowledgeSection([
      item({ attachmentId: "att_1", filename: "first.txt", fullText: null, summary: crossingSummary }),
      item({ attachmentId: "att_2", filename: "second.txt", fullText: "SOME_FULL_TEXT", summary: null }),
    ])

    const secondIdx = block.indexOf("### second.txt")
    expect(secondIdx).toBeGreaterThan(-1)
    expect(block.slice(secondIdx)).toContain("…[truncated]")
    expect(block).not.toContain("SOME_FULL_TEXT")
  })
})
