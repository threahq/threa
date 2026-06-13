import { describe, it, expect } from "vitest"
import { render } from "@testing-library/react"
import { extractSearchTerms, buildSnippet, HighlightedText } from "./highlight"

describe("extractSearchTerms", () => {
  it("splits bare words into terms", () => {
    expect(extractSearchTerms("deploy checklist")).toEqual(["deploy", "checklist"])
  })

  it("keeps quoted phrases as a single term", () => {
    expect(extractSearchTerms('"chicken wingz" recipe')).toEqual(["chicken wingz", "recipe"])
  })

  it("drops single-character noise terms", () => {
    expect(extractSearchTerms("a deploy b")).toEqual(["deploy"])
  })

  it("returns no terms for empty text", () => {
    expect(extractSearchTerms("")).toEqual([])
  })
})

describe("buildSnippet", () => {
  it("strips markdown before windowing (INV-60)", () => {
    const snippet = buildSnippet("**bold** and [a link](https://example.com)", ["bold"])
    expect(snippet.text).not.toContain("**")
    expect(snippet.text).not.toContain("](")
    expect(snippet.text).toContain("bold")
  })

  it("windows around the first match when it sits deep in the content", () => {
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
    const content = filler.repeat(4) + "the needle is here" + filler
    const snippet = buildSnippet(content, ["needle"])
    expect(snippet.truncatedStart).toBe(true)
    expect(snippet.text).toContain("needle")
    // The lead-in stays short so the match is visible in a two-line clamp
    expect(snippet.text.indexOf("needle")).toBeLessThan(60)
  })

  it("falls back to the start of the message when no term matches (semantic hit)", () => {
    const snippet = buildSnippet("completely unrelated content", ["needle"])
    expect(snippet.truncatedStart).toBe(false)
    expect(snippet.text).toContain("completely unrelated")
  })

  it("matches terms case-insensitively", () => {
    const snippet = buildSnippet("x".repeat(100) + " NEEDLE here", ["needle"])
    expect(snippet.truncatedStart).toBe(true)
    expect(snippet.text).toContain("NEEDLE")
  })
})

describe("HighlightedText", () => {
  it("wraps case-insensitive matches in <mark>", () => {
    const { container } = render(<HighlightedText text="Hello world, hello again" terms={["hello"]} />)
    const marks = Array.from(container.querySelectorAll("mark"), (m) => m.textContent)
    expect(marks).toEqual(["Hello", "hello"])
  })

  it("renders plain text when there are no terms", () => {
    const { container } = render(<HighlightedText text="just text" terms={[]} />)
    expect(container.querySelectorAll("mark")).toHaveLength(0)
    expect(container.textContent).toBe("just text")
  })

  it("escapes regex metacharacters in terms", () => {
    const { container } = render(<HighlightedText text="cost is $5 (approx)" terms={["$5", "(approx)"]} />)
    const marks = Array.from(container.querySelectorAll("mark"), (m) => m.textContent)
    expect(marks).toEqual(["$5", "(approx)"])
  })
})
