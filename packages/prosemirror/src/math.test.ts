import { describe, expect, it } from "bun:test"
import { findMathSpans, normalizeMathDelimiters } from "./math"

const texOf = (text: string) => findMathSpans(text).map((span) => ({ tex: span.tex, display: span.display }))

describe("findMathSpans", () => {
  it("finds inline math", () => {
    expect(texOf("Euler: $e^{i\\pi} + 1 = 0$ nice")).toEqual([{ tex: "e^{i\\pi} + 1 = 0", display: false }])
  })

  it("finds display math and trims it", () => {
    expect(texOf("$$\n\\frac{9}{31}\n$$")).toEqual([{ tex: "\\frac{9}{31}", display: true }])
  })

  it("finds several spans in one run", () => {
    expect(texOf("$a$ then $b$")).toEqual([
      { tex: "a", display: false },
      { tex: "b", display: false },
    ])
  })

  it("reports the slice each span covers", () => {
    expect(findMathSpans("x $a$ y")).toEqual([{ start: 2, end: 5, tex: "a", display: false }])
  })

  describe("leaves prose alone", () => {
    it.each([
      ["two prices", "costs $5 and $10 total"],
      ["thousands separators", "USD $1,000 vs EUR $2,000 difference"],
      ["a range", "$50-$60 range"],
      ["one price", "price is $5"],
      ["a lone shell variable", "and $PATH here"],
      ["spaced dollars", "a $ b $ c"],
      ["a numeric span", "I paid $5$."],
      ["an unclosed delimiter", "broken $x + 1 here"],
      ["a dollar glued to a word", "USD100$x$"],
      ["a blank line inside the span", "$a\n\nb$"],
    ])("%s", (_case, text) => {
      expect(texOf(text)).toEqual([])
    })
  })
})

describe("normalizeMathDelimiters", () => {
  it("rewrites display delimiters, collapsing the blank lines LLMs put inside", () => {
    expect(normalizeMathDelimiters("\\[\n\n0.31 + 0.31w > 0.40\n\n\\]")).toBe("$$0.31 + 0.31w > 0.40$$")
  })

  it("rewrites inline delimiters and trims so the strict scanner accepts them", () => {
    expect(normalizeMathDelimiters("inline \\( x^2 \\) here")).toBe("inline $x^2$ here")
  })

  it("leaves markdown without backslash delimiters untouched", () => {
    const markdown = "a $x$ and a \\$5 price"
    expect(normalizeMathDelimiters(markdown)).toBe(markdown)
  })

  it("leaves an escaped backslash alone", () => {
    expect(normalizeMathDelimiters("a \\\\[not math\\\\]")).toBe("a \\\\[not math\\\\]")
  })

  it("leaves an unclosed delimiter alone", () => {
    expect(normalizeMathDelimiters("open \\[ and nothing else")).toBe("open \\[ and nothing else")
  })

  it("skips fenced code", () => {
    const markdown = "```\nprice \\[x\\]\n```\nthen \\[y\\]"
    expect(normalizeMathDelimiters(markdown)).toBe("```\nprice \\[x\\]\n```\nthen $$y$$")
  })

  it("skips tilde fences", () => {
    const markdown = "~~~\n\\[x\\]\n~~~"
    expect(normalizeMathDelimiters(markdown)).toBe(markdown)
  })

  it("skips code spans", () => {
    expect(normalizeMathDelimiters("run `\\[x\\]` then \\[y\\]")).toBe("run `\\[x\\]` then $$y$$")
  })

  it("skips an unterminated fence to the end of the document", () => {
    const markdown = "```\n\\[x\\]\nstill code \\[y\\]"
    expect(normalizeMathDelimiters(markdown)).toBe(markdown)
  })
})
