import { describe, test, expect } from "bun:test"
import { supportedLanguages, toISO2 } from "tinyld"
import { SEARCH_CONFIG_BY_LANGUAGE, UNDETECTED_LANGUAGE, detectTextLanguage } from "./text-language"

describe("detectTextLanguage", () => {
  test("should name the language of a chat-length message", () => {
    const samples = {
      sv: "Jag har skickat fakturorna nu, säg till om något saknas",
      en: "Deploy went through, everything looks green in prod",
      de: "Das Meeting wurde auf Donnerstag verschoben",
      fr: "Peux-tu vérifier les logs sur le serveur",
    }
    const detected: Record<string, string> = {}
    for (const [code, text] of Object.entries(samples)) detected[code] = detectTextLanguage(text)
    expect(detected).toEqual({ sv: "sv", en: "en", de: "de", fr: "fr" })
  })

  test("should report und when the text is too short or ambiguous to place", () => {
    expect(["ok", "kolla loggarna", "```ts\nconst x = await fetch(url)\n```"].map(detectTextLanguage)).toEqual([
      UNDETECTED_LANGUAGE,
      UNDETECTED_LANGUAGE,
      UNDETECTED_LANGUAGE,
    ])
  })

  test("should only map codes tinyld can return", () => {
    const detectable = new Set((supportedLanguages as unknown as string[]).map((iso3) => toISO2(iso3)))
    expect(Object.keys(SEARCH_CONFIG_BY_LANGUAGE).filter((code) => !detectable.has(code))).toEqual([])
  })
})
