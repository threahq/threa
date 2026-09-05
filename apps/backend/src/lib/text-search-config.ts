import { detectAll } from "tinyld"

/** tinyld ISO 639-1 code → the Postgres text-search config that stems that language. */
const SEARCH_CONFIG_BY_LANGUAGE: ReadonlyMap<string, string> = new Map([
  ["ar", "arabic"],
  ["hy", "armenian"],
  ["da", "danish"],
  ["nl", "dutch"],
  ["en", "english"],
  ["fi", "finnish"],
  ["fr", "french"],
  ["de", "german"],
  ["el", "greek"],
  ["hi", "hindi"],
  ["hu", "hungarian"],
  ["id", "indonesian"],
  ["ga", "irish"],
  ["it", "italian"],
  ["lt", "lithuanian"],
  ["no", "norwegian"],
  ["pt", "portuguese"],
  ["ro", "romanian"],
  ["ru", "russian"],
  ["sr", "serbian"],
  ["es", "spanish"],
  ["sv", "swedish"],
  ["ta", "tamil"],
  ["tr", "turkish"],
  ["yi", "yiddish"],
])

export const DEFAULT_SEARCH_CONFIG = "english"

export const SEARCH_TEXT_CONFIGS: readonly string[] = [...SEARCH_CONFIG_BY_LANGUAGE.values()]

/**
 * Below this tinyld is guessing on chat-length text. Falling back to English
 * only loses inflection matching; a wrong config stems with the wrong language.
 */
const MIN_DETECTION_ACCURACY = 0.5

/** The text-search config to stem a message body with; English when unsure. */
export function detectSearchConfig(text: string): string {
  const best = detectAll(text)[0]
  if (!best || best.accuracy < MIN_DETECTION_ACCURACY) return DEFAULT_SEARCH_CONFIG
  return SEARCH_CONFIG_BY_LANGUAGE.get(best.lang) ?? DEFAULT_SEARCH_CONFIG
}
