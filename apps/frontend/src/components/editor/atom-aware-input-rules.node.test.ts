import { describe, it, expect } from "vitest"

/**
 * Test the regex patterns used in atom-aware input rules.
 *
 * Since testing TipTap input rules in jsdom is difficult (DOM events don't
 * properly trigger ProseMirror's input handling), we test the regex patterns
 * directly to ensure correct matching behavior.
 */

// Helper to escape regex special chars (same as in the implementation)
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Build pattern like the implementation does
function buildPattern(openMarker: string, closeMarker: string): RegExp {
  const openEsc = escapeRegex(openMarker)
  const closeEsc = escapeRegex(closeMarker)

  let contentPattern: string
  const lookbehind = `(?<=^|\\s)`

  if (openMarker.length === 1) {
    const charExclusion = openEsc
    contentPattern = `[^\\s${charExclusion}]|[^\\s${charExclusion}][\\s\\S]*?[^\\s]`
  } else {
    contentPattern = `[^\\s]|[^\\s][\\s\\S]*?[^\\s]`
  }

  return new RegExp(`${lookbehind}${openEsc}(${contentPattern})${closeEsc}$`)
}

describe("Atom-aware input rule patterns", () => {
  describe("bold pattern (**)", () => {
    const pattern = buildPattern("**", "**")

    it("should match **hello**", () => {
      const match = "**hello**".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello")
    })

    it("should match **hello world**", () => {
      const match = "**hello world**".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello world")
    })

    it("should not match incomplete **hello*", () => {
      const match = "**hello*".match(pattern)
      expect(match).toBeNull()
    })

    it("should not match ** ** (whitespace only)", () => {
      const match = "**  **".match(pattern)
      expect(match).toBeNull()
    })

    it("should not match ** hello** (starts with space)", () => {
      const match = "** hello**".match(pattern)
      expect(match).toBeNull()
    })

    it("should not match **hello ** (ends with space)", () => {
      const match = "**hello **".match(pattern)
      expect(match).toBeNull()
    })
  })

  describe("italic pattern (*)", () => {
    const pattern = buildPattern("*", "*")

    it("should match *hello*", () => {
      const match = "*hello*".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello")
    })

    it("should NOT match **hello** (should be bold, not italic)", () => {
      // The italic pattern should not match bold syntax
      const match = "**hello**".match(pattern)
      expect(match).toBeNull()
    })

    it("should NOT match **hello* (incomplete bold)", () => {
      // Should not match because first * is preceded by another *
      const match = "**hello*".match(pattern)
      expect(match).toBeNull()
    })

    it("should NOT match in word like prefix*hello* (no leading whitespace)", () => {
      // Opening `*` must be preceded by whitespace or start-of-text.
      const match = "prefix*hello*".match(pattern)
      expect(match).toBeNull()
    })

    it("should match after a space: hi *friend*", () => {
      const match = "hi *friend*".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("friend")
    })
  })

  describe("italic pattern (_)", () => {
    const pattern = buildPattern("_", "_")

    it("should match _hello_", () => {
      const match = "_hello_".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello")
    })

    it("should NOT match __hello__ (should be bold, not italic)", () => {
      const match = "__hello__".match(pattern)
      expect(match).toBeNull()
    })

    it("should NOT match f_name_2.py (no leading whitespace)", () => {
      // Opening `_` must be preceded by whitespace or start-of-text.
      const match = "f_name_2.py".match(pattern)
      expect(match).toBeNull()
    })

    it("should NOT match hi_friend_ (no leading whitespace before opening _)", () => {
      const match = "hi_friend_".match(pattern)
      expect(match).toBeNull()
    })

    it("should match hi _friend_ (leading space before opening _)", () => {
      const match = "hi _friend_".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("friend")
    })
  })

  describe("strikethrough pattern (~~)", () => {
    const pattern = buildPattern("~~", "~~")

    it("should match ~~hello~~", () => {
      const match = "~~hello~~".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello")
    })

    it("should not match ~hello~", () => {
      const match = "~hello~".match(pattern)
      expect(match).toBeNull()
    })
  })

  describe("inline code pattern (`)", () => {
    const pattern = buildPattern("`", "`")

    it("should match `hello`", () => {
      const match = "`hello`".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello")
    })

    it("should match `hello world`", () => {
      const match = "`hello world`".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello world")
    })

    it("should NOT match ``hello`` (double backtick)", () => {
      const match = "``hello``".match(pattern)
      expect(match).toBeNull()
    })
  })

  describe("content with special characters", () => {
    it("bold should handle content with mentions (simulated as @text)", () => {
      const pattern = buildPattern("**", "**")
      const match = "**Hello @ariadne**".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("Hello @ariadne")
    })

    it("italic should handle content with multiple words", () => {
      const pattern = buildPattern("*", "*")
      const match = "*Hello @ariadne and @kristoffer*".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("Hello @ariadne and @kristoffer")
    })
  })

  describe("edge cases", () => {
    it("should match single character content", () => {
      const pattern = buildPattern("*", "*")
      const match = "*a*".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("a")
    })

    it("should match content with numbers", () => {
      const pattern = buildPattern("*", "*")
      const match = "*hello123*".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("hello123")
    })

    it("should match content with internal asterisks for bold", () => {
      // **a*b** should work - content is "a*b"
      const pattern = buildPattern("**", "**")
      const match = "**a*b**".match(pattern)
      expect(match).not.toBeNull()
      expect(match![1]).toBe("a*b")
    })
  })
})
