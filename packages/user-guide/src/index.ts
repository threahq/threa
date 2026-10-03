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

function parseFrontMatter(slug: string, raw: string): { fields: Map<string, string>; body: string } {
  const match = FRONT_MATTER.exec(raw)
  if (!match) throw new Error(`Guide article "${slug}": missing front matter block`)
  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "") continue
    const field = FIELD.exec(line)
    if (!field) throw new Error(`Guide article "${slug}": front matter line is not "key: value": ${line}`)
    fields.set(field[1]!, field[2]!.trim())
  }
  return { fields, body: raw.slice(match[0].length).trim() }
}

export function parseGuideArticle(slug: string, raw: string): GuideArticle {
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

  if (body === "") throw new Error(`Guide article "${slug}": body is empty`)

  return { slug, title: need("title"), summary: need("summary"), section: section.id, order: Number(orderText), body }
}

const sectionIndex = (id: GuideSectionId) => GUIDE_SECTIONS.findIndex((s) => s.id === id)

/** Articles in reading order: by section, then `order`, then slug. */
export function sortGuideArticles(articles: GuideArticle[]): GuideArticle[] {
  return [...articles].sort(
    (a, b) => sectionIndex(a.section) - sectionIndex(b.section) || a.order - b.order || a.slug.localeCompare(b.slug)
  )
}

export function loadGuideArticles(): GuideArticle[] {
  const dir = fileURLToPath(new URL("../content", import.meta.url))
  const articles = readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => parseGuideArticle(file.slice(0, -3), readFileSync(`${dir}/${file}`, "utf8")))
  return sortGuideArticles(articles)
}
