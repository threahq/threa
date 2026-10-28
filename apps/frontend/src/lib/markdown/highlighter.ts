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

// Lazy singleton: warmed by the first load request, then reused.
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

async function ensureLanguage(hl: HighlighterGeneric<string, Theme>, lang: string): Promise<boolean> {
  if (hl.getLoadedLanguages().includes(lang)) return true
  try {
    await hl.loadLanguage(lang)
    return true
  } catch {
    return false
  }
}

/** True once `lang` can be tokenized synchronously. */
export async function loadCodeLanguage(lang: string): Promise<boolean> {
  const hl = await initHighlighter().catch(() => null)
  return hl !== null && (await ensureLanguage(hl, normalizeCodeLanguage(lang)))
}

// Renders as plaintext when the language is unknown, failed to fetch or fails
// to render, so callers render instead of waiting.
export async function ensureHighlight(code: string, lang: string): Promise<string | null> {
  const hl = await initHighlighter().catch(() => null)
  if (!hl) return null
  const normalized = normalizeCodeLanguage(lang)
  if (await ensureLanguage(hl, normalized)) {
    try {
      return hl.codeToHtml(code, { lang: normalized, ...THEME_OPTIONS })
    } catch {
      // Falls through to plaintext.
    }
  }
  try {
    return hl.codeToHtml(code, { lang: PLAINTEXT_LANGUAGE_ID, ...THEME_OPTIONS })
  } catch {
    return null
  }
}
