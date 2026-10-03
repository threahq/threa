import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

export const GUIDE_SECTIONS = [
  { id: "getting-started", title: "Getting started" },
  { id: "conversations", title: "Conversations" },
  { id: "messages", title: "Messages" },
  { id: "memory", title: "Memory" },
  { id: "agents", title: "Agents and Ariadne" },
  { id: "search", title: "Search" },
  { id: "notifications", title: "Notifications and activity" },
  { id: "settings", title: "Settings and account" },
  { id: "workspace", title: "Running a workspace" },
  { id: "integrations", title: "Integrations" },
  { id: "privacy", title: "Privacy and security" },
  { id: "apps", title: "Mobile and desktop apps" },
] as const

export type GuideSectionId = (typeof GUIDE_SECTIONS)[number]["id"]

export interface GuideArticle {
  slug: string
  title: string
  summary: string
  section: GuideSectionId
  order: number
  body: string
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/
const FIELD = /^([a-z]+):\s*(.*)$/
const FIELDS = new Set(["title", "summary", "section", "order"])
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseFrontMatter(slug: string, raw: string): { fields: Map<string, string>; body: string } {
  const match = FRONT_MATTER.exec(raw)
  if (!match) throw new Error(`Guide article "${slug}": missing front matter block`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "") continue
    const field = FIELD.exec(line)
    if (!field) throw new Error(`Guide article "${slug}": front matter line is not "key: value": ${line}`)
    const key = field[1]!
    const value = field[2]!.trim()
    if (!FIELDS.has(key)) throw new Error(`Guide article "${slug}": unknown front matter key "${key}"`)
    // Values are taken verbatim, so YAML quoting would leak the quotes into titles.
    if (/^["']/.test(value)) throw new Error(`Guide article "${slug}": "${key}" must not be quoted`)
    if (fields.has(key)) throw new Error(`Guide article "${slug}": front matter repeats "${key}"`)
    fields.set(key, value)
  }
  return { fields, body: raw.slice(match[0].length).trim() }
}

export function parseGuideArticle(slug: string, raw: string): GuideArticle {
  // "index" is the overview page's route.
  if (!SLUG.test(slug) || slug === "index") {
    throw new Error(`Guide article "${slug}": file name must be a lowercase-hyphenated slug other than "index"`)
  }
  const { fields, body } = parseFrontMatter(slug, raw)
  const need = (key: string): string => {
    const value = fields.get(key)
    if (!value) throw new Error(`Guide article "${slug}": front matter needs "${key}"`)
    return value
  }

  const section = GUIDE_SECTIONS.find((s) => s.id === need("section"))
  if (!section) {
    throw new Error(
      `Guide article "${slug}": unknown section "${fields.get("section")}" (one of ${GUIDE_SECTIONS.map((s) => s.id).join(", ")})`
    )
  }

  const orderText = need("order")
  if (!/^\d+$/.test(orderText))
    throw new Error(`Guide article "${slug}": "order" must be an integer, got "${orderText}"`)

  const title = need("title")
  // The body's heading is the page's visible h1 and the mirror's first line.
  if (body.split("\n", 1)[0] !== `# ${title}`)
    throw new Error(`Guide article "${slug}": body must start with "# ${title}"`)

  return { slug, title, summary: need("summary"), section: section.id, order: Number(orderText), body }
}

const sectionIndex = (id: GuideSectionId) => GUIDE_SECTIONS.findIndex((s) => s.id === id)

/** Articles in reading order: by section, then `order`, then slug. */
export function sortGuideArticles(articles: GuideArticle[]): GuideArticle[] {
  return [...articles].sort(
    (a, b) => sectionIndex(a.section) - sectionIndex(b.section) || a.order - b.order || a.slug.localeCompare(b.slug)
  )
}

/** Articles from `content/*.md`, keyed by any path ending in the file name, in reading order. */
export function guideArticlesFromFiles(files: Record<string, string>): GuideArticle[] {
  return sortGuideArticles(
    Object.entries(files).map(([path, raw]) =>
      parseGuideArticle(path.slice(path.lastIndexOf("/") + 1, -".md".length), raw)
    )
  )
}

export function loadGuideArticles(): GuideArticle[] {
  const dir = fileURLToPath(new URL("../content", import.meta.url))
  const files = readdirSync(dir).filter((file) => file.endsWith(".md"))
  return guideArticlesFromFiles(Object.fromEntries(files.map((file) => [file, readFileSync(`${dir}/${file}`, "utf8")])))
}
