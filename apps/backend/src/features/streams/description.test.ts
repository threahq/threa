import { describe, expect, test } from "bun:test"
import { normalizeStreamDescription } from "./description"

describe("normalizeStreamDescription", () => {
  test("returns undefined when neither field is supplied (leave untouched)", () => {
    expect(normalizeStreamDescription({})).toBeUndefined()
  })

  test("parses a markdown description into canonical ProseMirror + markdown", () => {
    const result = normalizeStreamDescription({ description: "Hello **world**" })
    expect(result?.descriptionJson?.type).toBe("doc")
    // Markdown is re-derived from the parsed JSON, so the projection round-trips.
    expect(result?.description).toBe("Hello **world**")
  })

  test("derives the markdown projection from a ProseMirror description", () => {
    const result = normalizeStreamDescription({
      descriptionJson: {
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] }],
      },
    })
    expect(result?.description).toBe("# Title")
    expect(result?.descriptionJson?.content?.[0]?.type).toBe("heading")
  })

  test("folds raw emoji to canonical shortcodes in the derived markdown", () => {
    const result = normalizeStreamDescription({ description: "Great 👍" })
    expect(result?.description).toBe("Great :+1:")
  })

  test("prefers descriptionJson over a supplied markdown description", () => {
    const result = normalizeStreamDescription({
      description: "ignored markdown",
      descriptionJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "kept" }] }] },
    })
    expect(result?.description).toBe("kept")
  })

  test("empty markdown clears the description", () => {
    expect(normalizeStreamDescription({ description: "   " })).toEqual({ description: null, descriptionJson: null })
  })

  test("an empty document clears the description", () => {
    expect(normalizeStreamDescription({ descriptionJson: { type: "doc", content: [{ type: "paragraph" }] } })).toEqual({
      description: null,
      descriptionJson: null,
    })
  })
})
