import { describe, expect, it } from "bun:test"
import { extractMath, scanMathSpans, splitMathTokens, type MathPart } from "./math"

/** What the renderer sees: literal text runs and the math lifted out of them. */
function parts(markdown: string): MathPart[] {
  const extracted = extractMath(markdown)
  return splitMathTokens(extracted) ?? [{ text: extracted }]
}

describe("extractMath", () => {
  it("lifts display math out of backslash delimiters", () => {
    expect(parts("Solve \\[ x^2 + 1 = 0 \\] now")).toEqual([
      { text: "Solve " },
      { tex: "x^2 + 1 = 0", display: true },
      { text: " now" },
    ])
  })

  it("lifts inline math out of backslash delimiters", () => {
    expect(parts("Let \\( p = 0.31 \\) hold")).toEqual([
      { text: "Let " },
      { tex: "p = 0.31", display: false },
      { text: " hold" },
    ])
  })

  it("lifts dollar math", () => {
    expect(parts("Euler: $e^{i\\pi} + 1 = 0$ and $$\\frac{a}{b}$$")).toEqual([
      { text: "Euler: " },
      { tex: "e^{i\\pi} + 1 = 0", display: false },
      { text: " and " },
      { tex: "\\frac{a}{b}", display: true },
    ])
  })

  it("keeps TeX escapes CommonMark would eat", () => {
    expect(parts("\\[ \\{x\\} \\\\ 50\\% \\_i \\]")).toEqual([{ tex: "\\{x\\} \\\\ 50\\% \\_i", display: true }])
  })

  it("keeps a body CommonMark emphasis would split", () => {
    expect(parts("$x^*$ and $y^*$")).toEqual([
      { tex: "x^*", display: false },
      { text: " and " },
      { tex: "y^*", display: false },
    ])
  })

  it("collapses the blank lines LLMs put inside display math", () => {
    expect(parts("\\[\n\n0.31 + 0.31w > 0.40\n\n\\]")).toEqual([{ tex: "0.31 + 0.31w > 0.40", display: true }])
  })

  it("takes the whole block when a nested inline delimiter sits inside it", () => {
    expect(parts("a \\[ x \\(y\\) \\] b")).toEqual([
      { text: "a " },
      { tex: "x \\(y\\)", display: true },
      { text: " b" },
    ])
  })

  it("leaves markdown without math untouched", () => {
    const markdown = "# Heading\n\nA [link](https://example.com) and **bold**.\n"
    expect(extractMath(markdown)).toBe(markdown)
  })

  describe("leaves prose alone", () => {
    it.each([
      ["two prices", "It costs $5 and $10 total"],
      ["thousands separators", "Revenue went from $1,000 to $2,000"],
      ["a range", "Somewhere between $50-$60 each"],
      ["one price", "That will be $42"],
      ["an env var", "Set $PATH before running"],
      ["spaced dollars", "The $ sign and another $ sign"],
      ["an escaped bracket", "See \\[1\\] for details"],
      ["an unclosed delimiter", "Half an equation $x + 1"],
      ["a glued opener", "cost$5 and x$y$"],
      ["a paragraph break", "$a\n\nb$"],
    ])("%s", (_name, markdown) => {
      expect(extractMath(markdown)).toBe(markdown)
    })
  })

  describe("leaves protected regions alone", () => {
    it.each([
      ["a fenced block", "```\n\\[ x \\]\n$y$\n```\n"],
      ["a tilde fence", "~~~\n\\( x \\)\n~~~\n"],
      ["a code span", "Type `\\[ x \\]` to start"],
      ["an unterminated fence", "```\n\\[ x \\]\n"],
      ["a link destination", "See [docs](https://x.test/a$b) and [more](https://y.test/c$d)"],
      ["bare autolinked URLs", "https://x.test/a$b then https://y.test/c$d"],
    ])("%s", (_name, markdown) => {
      expect(extractMath(markdown)).toBe(markdown)
    })

    it("does not let a stray backtick swallow the paragraphs after it", () => {
      expect(parts("use the ` char\n\nnow \\[x + 1\\] here\n\nand ` again")).toEqual([
        { text: "use the ` char\n\nnow " },
        { tex: "x + 1", display: true },
        { text: " here\n\nand ` again" },
      ])
    })
  })

  it("scans prose full of prices without rescanning it per dollar sign", () => {
    // Every `$` here opens and never closes. Searching for the closer from each
    // opener in turn was quadratic: this took 590 ms before the closers were
    // collected in one pass, against ~6 ms after.
    const prices = "lorem ipsum $dollar amounts $5 and $10 ".repeat(1500)
    const started = performance.now()
    expect(extractMath(prices)).toBe(prices)
    expect(performance.now() - started).toBeLessThan(200)
  })

  it("separates a price from real math in the same sentence", () => {
    expect(parts("The price is $5, so $p = 5$.")).toEqual([
      { text: "The price is $5, so " },
      { tex: "p = 5", display: false },
      { text: "." },
    ])
  })
})

describe("splitMathTokens", () => {
  it("returns null for text the extractor never touched", () => {
    expect(splitMathTokens("plain text with $5 in it")).toBeNull()
  })
})

describe("scanMathSpans", () => {
  it("locates each span by the offsets its delimiters occupy", () => {
    const text = "Let $p = 5$ and \\[ x^2 \\] hold"
    const spans = scanMathSpans(text)
    expect(spans).toEqual([
      { from: 4, to: 11, tex: "p = 5", display: false },
      { from: 16, to: 25, tex: "x^2", display: true },
    ])
    expect(spans.map((span) => text.slice(span.from, span.to))).toEqual(["$p = 5$", "\\[ x^2 \\]"])
  })

  it("rejects what the extractor rejects", () => {
    expect(scanMathSpans("costs $5 and $10 total")).toEqual([])
    expect(scanMathSpans("$PATH is $unset")).toEqual([])
    expect(scanMathSpans("half typed $\\frac{")).toEqual([])
  })
})
