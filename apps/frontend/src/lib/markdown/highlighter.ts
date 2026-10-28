import { createHighlighter, type HighlighterGeneric, type ThemedToken } from "shiki"
import { CODE_LANGUAGE_PRELOAD_IDS, PLAINTEXT_LANGUAGE_ID, normalizeCodeLanguage } from "@threahq/types"

// Warmed at boot so common code blocks paint highlighted on first render.
// Unknown langs fall through to `loadLanguage()` and then to plaintext.
const PRELOAD_LANGS = CODE_LANGUAGE_PRELOAD_IDS

const THEMES = ["github-light", "github-dark"] as const

type Theme = (typeof THEMES)[number]

let highlighter: HighlighterGeneric<string, Theme> | null = null
let initPromise: Promise<HighlighterGeneric<string, Theme>> | null = null

const THEME_OPTIONS = {
  themes: { light: "github-light", dark: "github-dark" } as Record<"light" | "dark", Theme>,
  defaultColor: false as const,
}

// Lazy singleton: warmed on the first `ensureHighlight` call, then reused.
// Failures aren't cached so a transient dynamic-import error doesn't
// permanently disable highlighting; the next caller retries.
function initHighlighter(): Promise<HighlighterGeneric<string, Theme>> {
  if (highlighter) return Promise.resolve(highlighter)
  if (initPromise) return initPromise
  initPromise = createHighlighter({
    langs: [...PRELOAD_LANGS],
    themes: [...THEMES],
  })
    .then((hl) => {
      highlighter = hl as HighlighterGeneric<string, Theme>
      return highlighter
    })
    .catch((err) => {
      initPromise = null
      throw err
    })
  return initPromise
}

// Returns null when the highlighter isn't ready or the language isn't loaded;
// callers fall through to `ensureHighlight`. The null return is what lets a
// warmed highlighter skip the placeholder → highlighted swap on first paint.
export function tryHighlightSync(code: string, lang: string): string | null {
  const hl = highlighter
  if (!hl) return null
  const normalized = normalizeCodeLanguage(lang)
  try {
    return hl.codeToHtml(code, { lang: normalized, ...THEME_OPTIONS })
  } catch {
    return null
  }
}

// Token lines for the editor's in-place highlighting; null until the
// highlighter and `lang` are loaded, which `loadCodeLanguage` gets to.
export function tryTokenizeSync(code: string, lang: string): ThemedToken[][] | null {
  const hl = highlighter
  if (!hl) return null
  try {
    return hl.codeToTokens(code, { lang: normalizeCodeLanguage(lang), ...THEME_OPTIONS }).tokens
  } catch {
    return null
  }
}

// Awaits init and lazy-loads the language. Resolves to plaintext when the
// language is unknown or failed to fetch, so callers render instead of waiting.
async function loadLanguage(lang: string): Promise<{ hl: HighlighterGeneric<string, Theme>; lang: string } | null> {
  let hl: HighlighterGeneric<string, Theme>
  try {
    hl = await initHighlighter()
  } catch {
    return null
  }
  const normalized = normalizeCodeLanguage(lang)
  if (hl.getLoadedLanguages().includes(normalized)) return { hl, lang: normalized }
  try {
    await hl.loadLanguage(normalized)
    return { hl, lang: normalized }
  } catch {
    return { hl, lang: PLAINTEXT_LANGUAGE_ID }
  }
}

/** True once `lang` itself (not the plaintext fallback) can be tokenized synchronously. */
export async function loadCodeLanguage(lang: string): Promise<boolean> {
  const loaded = await loadLanguage(lang)
  return loaded?.lang === normalizeCodeLanguage(lang)
}

export async function ensureHighlight(code: string, lang: string): Promise<string | null> {
  const loaded = await loadLanguage(lang)
  if (!loaded) return null
  try {
    return loaded.hl.codeToHtml(code, { lang: loaded.lang, ...THEME_OPTIONS })
  } catch {
    return null
  }
}
