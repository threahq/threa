/*
 * Build-time syntax highlighting for docs code samples.
 *
 * Wraps Shiki with two custom themes on the site's palette, one per site theme:
 * gold for keywords and JSON keys, warm strings, muted comments. Each token
 * carries both colors as --shiki-light / --shiki-dark and CSS picks one, so the
 * theme toggle needs no re-render. The highlighter is a module singleton so
 * the ~26 blocks on the reference page share one instance per build.
 *
 * The {{baseUrl}} / {{workspaceId}} / {{apiKey}} playground tokens must
 * survive tokenization as single units (the grammar would otherwise split the
 * braces from the name). highlight() swaps them for identifier-shaped
 * sentinels before tokenizing and swaps chip markup back in afterwards; the
 * chips are then hydrated client-side by scripts/playground.ts, same as before.
 */

import { createHighlighter, type BundledLanguage, type Highlighter, type ThemeRegistration } from "shiki"

export type CodeLang = "bash" | "ts" | "json" | "text"

const SHIKI_LANG: Record<Exclude<CodeLang, "text">, BundledLanguage> = {
  bash: "bash",
  ts: "typescript",
  json: "json",
}

/* Token colors only; the surface is owned by CSS (.pg-pre in styles/docs.css). */
const threaDusk: ThemeRegistration = {
  name: "threa-dusk",
  type: "dark",
  colors: {
    "editor.background": "#201a13",
    "editor.foreground": "#e6ded2",
  },
  settings: [
    { settings: { foreground: "#e6ded2" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#8c8273" },
    },
    {
      scope: ["string", "string.template", "punctuation.definition.string"],
      settings: { foreground: "#c8b080" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.other"],
      settings: { foreground: "#dfa567" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: "#e2a554" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "#c9bca8" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
      settings: { foreground: "#efe6d4" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter"],
      settings: { foreground: "#e6ded2" },
    },
    {
      // JSON keys — gold, so payload shape pops the way the brand does.
      scope: ["support.type.property-name", "meta.object-literal.key"],
      settings: { foreground: "#e2a554" },
    },
    {
      scope: ["punctuation", "meta.brace"],
      settings: { foreground: "#a1968a" },
    },
  ],
}

const threaDawn: ThemeRegistration = {
  name: "threa-dawn",
  type: "light",
  colors: {
    "editor.background": "#fbfaf7",
    "editor.foreground": "#2a241d",
  },
  settings: [
    { settings: { foreground: "#2a241d" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#736a5d" },
    },
    {
      scope: ["string", "string.template", "punctuation.definition.string"],
      settings: { foreground: "#6a5a2c" },
    },
    {
      scope: ["constant.numeric", "constant.language", "constant.other"],
      settings: { foreground: "#a24e1c" },
    },
    {
      scope: ["keyword", "storage.type", "storage.modifier", "keyword.control"],
      settings: { foreground: "#94600f" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "#62584b" },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call.generic"],
      settings: { foreground: "#1f1a14" },
    },
    {
      scope: ["variable", "variable.other", "variable.parameter"],
      settings: { foreground: "#2a241d" },
    },
    {
      scope: ["support.type.property-name", "meta.object-literal.key"],
      settings: { foreground: "#94600f" },
    },
    {
      scope: ["punctuation", "meta.brace"],
      settings: { foreground: "#7a7063" },
    },
  ],
}

const VAR_NAMES = ["baseUrl", "workspaceId", "apiKey"] as const
const sentinel = (name: string) => `__PGVAR_${name}__`

let highlighterPromise: Promise<Highlighter> | null = null
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [threaDawn, threaDusk],
    langs: Object.values(SHIKI_LANG),
  })
  return highlighterPromise
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/* Highlight a code template into inner-<code> HTML: colored spans per token,
   with each {{var}} replaced by an (empty) chip span the playground fills. */
export async function highlightCode(code: string, lang: CodeLang): Promise<string> {
  let prepared = code
  for (const name of VAR_NAMES) {
    prepared = prepared.replaceAll(`{{${name}}}`, sentinel(name))
  }

  // Plain text (e.g. the agent prompt block): no grammar, just escape + chips.
  if (lang === "text") {
    return escapeHtml(prepared).replace(/__PGVAR_(baseUrl|workspaceId|apiKey)__/g, (_, name: string) => {
      return `<span class="pg-var is-unset" data-var="${name}"></span>`
    })
  }

  const hl = await getHighlighter()
  const { tokens } = hl.codeToTokens(prepared, {
    lang: SHIKI_LANG[lang],
    themes: { light: "threa-dawn", dark: "threa-dusk" },
    defaultColor: false,
  })

  // <wbr> after each slash lets a block that wraps (the API reference) break a
  // long URL at a path segment rather than mid-word. Copy and the markdown
  // mirror read the raw template, so it never reaches copied text.
  const html = tokens
    .map((line) =>
      line
        .map((t) => {
          const style = t.htmlStyle ?? {}
          return `<span style="--shiki-light:${style["--shiki-light"]};--shiki-dark:${style["--shiki-dark"]}">${escapeHtml(t.content).replaceAll("/", "/<wbr>")}</span>`
        })
        .join("")
    )
    .join("\n")

  return html.replace(/__PGVAR_(baseUrl|workspaceId|apiKey)__/g, (_, name: string) => {
    return `<span class="pg-var is-unset" data-var="${name}"></span>`
  })
}
