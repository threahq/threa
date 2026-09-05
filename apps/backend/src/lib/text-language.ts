import { detectAll } from "tinyld"

/**
 * Detector language code → Postgres text-search config. Mirrors
 * `search_config_for_language` in the message_language_search_config
 * migration: a message's `search_vector` is stemmed with the config for its
 * stored code, and a search query is stemmed with every config here and
 * OR-ed, so a query in any language reaches messages stored under any config.
 * Every language tinyld detects that Postgres ships a stemmer for.
 */
export const SEARCH_CONFIG_BY_LANGUAGE = {
  ar: "arabic",
  hy: "armenian",
  da: "danish",
  nl: "dutch",
  en: "english",
  fi: "finnish",
  fr: "french",
  de: "german",
  el: "greek",
  hi: "hindi",
  hu: "hungarian",
  id: "indonesian",
  ga: "irish",
  it: "italian",
  lt: "lithuanian",
  no: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sr: "serbian",
  es: "spanish",
  sv: "swedish",
  ta: "tamil",
  tr: "turkish",
  yi: "yiddish",
} as const

export type DetectedLanguage = keyof typeof SEARCH_CONFIG_BY_LANGUAGE

/** Stored when the text is too short or too ambiguous to place; stems as English. */
export const UNDETECTED_LANGUAGE = "und"

export const SEARCH_TEXT_CONFIGS: readonly string[] = Object.values(SEARCH_CONFIG_BY_LANGUAGE)

/**
 * Below this, tinyld is guessing: on chat-length samples every wrong call had
 * a lower score and every correct call on 30+ characters scored 0.55 or more.
 * A miss costs only inflection matching (the row stems as English, as today),
 * a wrong call stems it with a foreign stemmer, so lean towards `und`.
 */
const MIN_DETECTION_ACCURACY = 0.5

function isSupported(code: string): code is DetectedLanguage {
  return Object.hasOwn(SEARCH_CONFIG_BY_LANGUAGE, code)
}

/**
 * Language of a message body for text-search stemming: a code from
 * {@link SEARCH_CONFIG_BY_LANGUAGE}, or {@link UNDETECTED_LANGUAGE}.
 */
export function detectTextLanguage(text: string): DetectedLanguage | typeof UNDETECTED_LANGUAGE {
  const best = detectAll(text)[0]
  if (!best || best.accuracy < MIN_DETECTION_ACCURACY || !isSupported(best.lang)) return UNDETECTED_LANGUAGE
  return best.lang
}
