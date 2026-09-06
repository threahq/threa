import { createHighlighter, type HighlighterGeneric } from "shiki"
import { CODE_LANGUAGE_PRELOAD_IDS, PLAINTEXT_LANGUAGE_ID, normalizeCodeLanguage } from "@threahq/types"

// Warmed at boot so common code blocks paint highlighted on first render.
// Unknown langs fall through to `loadLanguage()` and then to plaintext.
const PRELOAD_LANGS = CODE_LANGUAGE_PRELOAD_IDS

const THEMES = ["github-light", "github-dark"] as const

type Theme = (typeof THEMES)[number]

let highlighter: HighlighterGeneric<string, Theme> | null = null
let initPromise: Promise<HighlighterGeneric<string, Theme>> | null = null

const CODE_TO_HTML_OPTIONS = {
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
    return hl.codeToHtml(code, { lang: normalized, ...CODE_TO_HTML_OPTIONS })
  } catch {
    return null
  }
}

// Awaits init, lazy-loads the language if missing, falls back to plaintext
// rather than leaving the block stuck on its unhighlighted placeholder.
export async function ensureHighlight(code: string, lang: string): Promise<string | null> {
  let hl: HighlighterGeneric<string, Theme>
  try {
    hl = await initHighlighter()
  } catch {
    return null
  }
  const normalized = normalizeCodeLanguage(lang)

  try {
    return hl.codeToHtml(code, { lang: normalized, ...CODE_TO_HTML_OPTIONS })
  } catch {
    // Language not pre-loaded — try to fetch it.
  }

  try {
    await hl.loadLanguage(normalized)
    return hl.codeToHtml(code, { lang: normalized, ...CODE_TO_HTML_OPTIONS })
  } catch {
    // Unknown or failed to fetch — render as plaintext so the block still
    // renders inside its panel rather than getting stuck on the placeholder.
    try {
      return hl.codeToHtml(code, { lang: PLAINTEXT_LANGUAGE_ID, ...CODE_TO_HTML_OPTIONS })
    } catch {
      return null
    }
  }
}
