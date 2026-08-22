/**
 * The one list of code-block languages: display labels, fence aliases, and
 * which ones the highlighter warms at boot. Ids are strings Shiki accepts, so
 * a normalized id goes straight to `codeToHtml`.
 */
export interface CodeLanguage {
  id: string
  label: string
  aliases: readonly string[]
  /** Loaded by the highlighter at boot so common blocks paint highlighted on first render. */
  preload?: true
}

export const PLAINTEXT_LANGUAGE_ID = "plaintext"

export const CODE_LANGUAGES = [
  { id: "typescript", label: "TypeScript", aliases: ["ts"], preload: true },
  { id: "tsx", label: "TSX", aliases: [], preload: true },
  { id: "javascript", label: "JavaScript", aliases: ["js", "mjs", "cjs"], preload: true },
  { id: "jsx", label: "JSX", aliases: [], preload: true },
  { id: "python", label: "Python", aliases: ["py"], preload: true },
  { id: "bash", label: "Bash", aliases: ["sh", "shell", "zsh", "shellscript"], preload: true },
  { id: "json", label: "JSON", aliases: ["jsonc"], preload: true },
  { id: "yaml", label: "YAML", aliases: ["yml"], preload: true },
  { id: "markdown", label: "Markdown", aliases: ["md"], preload: true },
  { id: "html", label: "HTML", aliases: [], preload: true },
  { id: "css", label: "CSS", aliases: [], preload: true },
  { id: "scss", label: "SCSS", aliases: [] },
  { id: "sql", label: "SQL", aliases: [], preload: true },
  { id: "rust", label: "Rust", aliases: ["rs"], preload: true },
  { id: "go", label: "Go", aliases: ["golang"], preload: true },
  { id: "java", label: "Java", aliases: [], preload: true },
  { id: "kotlin", label: "Kotlin", aliases: ["kt"] },
  { id: "swift", label: "Swift", aliases: [] },
  { id: "ruby", label: "Ruby", aliases: ["rb"], preload: true },
  { id: "php", label: "PHP", aliases: [], preload: true },
  { id: "csharp", label: "C#", aliases: ["cs", "c#"] },
  { id: "cpp", label: "C++", aliases: ["c++"] },
  { id: "c", label: "C", aliases: [] },
  { id: "diff", label: "Diff", aliases: [], preload: true },
  { id: "dockerfile", label: "Dockerfile", aliases: ["docker"] },
  { id: "graphql", label: "GraphQL", aliases: ["gql"] },
  { id: "xml", label: "XML", aliases: [] },
  { id: "toml", label: "TOML", aliases: [] },
  { id: PLAINTEXT_LANGUAGE_ID, label: "Plain text", aliases: ["text", "txt", "plain"] },
] as const satisfies readonly CodeLanguage[]

export type CodeLanguageId = (typeof CODE_LANGUAGES)[number]["id"]

export const CODE_LANGUAGE_IDS = CODE_LANGUAGES.map((language) => language.id) as [CodeLanguageId, ...CodeLanguageId[]]

export const CODE_LANGUAGE_PRELOAD_IDS = CODE_LANGUAGES.filter((language) => "preload" in language).map(
  (language) => language.id
)

const languageById = new Map<string, CodeLanguage>(CODE_LANGUAGES.map((language) => [language.id, language]))

const idByAlias = new Map<string, string>(
  CODE_LANGUAGES.flatMap((language) => language.aliases.map((alias) => [alias, language.id] as const))
)

/**
 * Fence info string → registry id. Unknown languages pass through lowercased so
 * the highlighter can still lazy-load them; an empty string is plain text.
 */
export function normalizeCodeLanguage(info: string | null | undefined): string {
  const trimmed = (info ?? "").trim().toLowerCase()
  if (!trimmed) return PLAINTEXT_LANGUAGE_ID
  return idByAlias.get(trimmed) ?? trimmed
}

export function formatCodeLanguage(id: string): string {
  return languageById.get(id)?.label ?? id
}
