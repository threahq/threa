import { describe, expect, it } from "bun:test"
import {
  CODE_LANGUAGES,
  CODE_LANGUAGE_IDS,
  CODE_LANGUAGE_PRELOAD_IDS,
  PLAINTEXT_LANGUAGE_ID,
  formatCodeLanguage,
  normalizeCodeLanguage,
} from "./code-languages"

describe("code language registry", () => {
  it("should keep ids and aliases disjoint and unique", () => {
    const ids = CODE_LANGUAGES.map((language) => language.id)
    const aliases = CODE_LANGUAGES.flatMap((language) => [...language.aliases])
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(aliases).size).toBe(aliases.length)
    expect(aliases.filter((alias) => ids.includes(alias as (typeof ids)[number]))).toEqual([])
  })

  it("should derive the id list and preload subset from the registry", () => {
    expect([...CODE_LANGUAGE_IDS]).toEqual(CODE_LANGUAGES.map((language) => language.id))
    expect(CODE_LANGUAGE_PRELOAD_IDS).toContain("typescript")
    expect(CODE_LANGUAGE_PRELOAD_IDS).not.toContain(PLAINTEXT_LANGUAGE_ID)
  })
})

describe("normalizeCodeLanguage", () => {
  it("should map fence aliases to the registry id", () => {
    expect(normalizeCodeLanguage("js")).toBe("javascript")
    expect(normalizeCodeLanguage("TS")).toBe("typescript")
    expect(normalizeCodeLanguage(" sh ")).toBe("bash")
    expect(normalizeCodeLanguage("c++")).toBe("cpp")
  })

  it("should treat an empty, bare, or text fence as plain text", () => {
    expect(normalizeCodeLanguage("")).toBe(PLAINTEXT_LANGUAGE_ID)
    expect(normalizeCodeLanguage(null)).toBe(PLAINTEXT_LANGUAGE_ID)
    expect(normalizeCodeLanguage(undefined)).toBe(PLAINTEXT_LANGUAGE_ID)
    expect(normalizeCodeLanguage("text")).toBe(PLAINTEXT_LANGUAGE_ID)
    expect(normalizeCodeLanguage("txt")).toBe(PLAINTEXT_LANGUAGE_ID)
  })

  it("should pass an unknown language through lowercased", () => {
    expect(normalizeCodeLanguage("Elixir")).toBe("elixir")
  })
})

describe("formatCodeLanguage", () => {
  it("should label registry ids and echo unknown ids", () => {
    expect(formatCodeLanguage("csharp")).toBe("C#")
    expect(formatCodeLanguage(PLAINTEXT_LANGUAGE_ID)).toBe("Plain text")
    expect(formatCodeLanguage("elixir")).toBe("elixir")
  })
})
