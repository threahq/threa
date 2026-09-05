import { describe, test, expect } from "bun:test"
import { DEFAULT_SEARCH_CONFIG, detectSearchConfig } from "./text-search-config"

describe("detectSearchConfig", () => {
  test("should pick the stemmer for a chat-length message", () => {
    const samples = {
      sv: "Jag har skickat fakturorna nu, säg till om något saknas",
      en: "Deploy went through, everything looks green in prod",
      de: "Das Meeting wurde auf Donnerstag verschoben",
      fr: "Peux-tu vérifier les logs sur le serveur",
    }
    const detected: Record<string, string> = {}
    for (const [code, text] of Object.entries(samples)) detected[code] = detectSearchConfig(text)
    expect(detected).toEqual({ sv: "swedish", en: "english", de: "german", fr: "french" })
  })

  test("should fall back to English when the text is too short or ambiguous to place", () => {
    expect(["ok", "kolla loggarna", "```ts\nconst x = await fetch(url)\n```"].map(detectSearchConfig)).toEqual([
      DEFAULT_SEARCH_CONFIG,
      DEFAULT_SEARCH_CONFIG,
      DEFAULT_SEARCH_CONFIG,
    ])
  })
})
