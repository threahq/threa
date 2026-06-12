/*
 * Post-build step: derive agent-readable markdown from the built docs HTML.
 *
 * Runs after `astro build` (see the package build script) and writes into dist:
 *   - /developers/<page>.md — a markdown mirror of each docs page
 *   - /llms.txt             — index per the llms.txt convention (llmstxt.org)
 *   - /llms-full.txt        — every docs page concatenated into one fetch
 *
 * The markdown is converted from the same HTML the site ships, so it cannot
 * drift from the pages. Code samples are taken from each block's raw
 * data-template (the visible HTML renders {{tokens}} as empty chips that the
 * playground fills client-side, so converting the <pre> would drop them) and
 * the tokens become literal placeholders an agent can substitute.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import TurndownService from "turndown"

const SITE = "https://threa.io"
const dist = (p: string) => fileURLToPath(new URL(`../dist/${p}`, import.meta.url))

const TOKEN_DEFAULTS: Record<string, string> = {
  baseUrl: "https://app.threa.io",
  workspaceId: "YOUR_WORKSPACE_ID",
  apiKey: "YOUR_API_KEY",
}

interface Page {
  /** URL path of the HTML page, also names the .md mirror. */
  route: string
  /** Built HTML file under dist/. */
  html: string
  /** .md mirror path under dist/ (and its URL). */
  md: string
  title: string
  /** One-line description for the llms.txt index. */
  blurb: string
}

const PAGES: Page[] = [
  {
    route: "/developers",
    html: "developers/index.html",
    md: "developers/index.md",
    title: "Overview & quickstart",
    blurb: "What the API covers, base URL, and a quickstart from key to first search.",
  },
  {
    route: "/developers/authentication",
    html: "developers/authentication/index.html",
    md: "developers/authentication.md",
    title: "Authentication",
    blurb: "Bearer keys, the three key kinds (threa_uk_/threa_bk_), scopes, and how missing scopes fail.",
  },
  {
    route: "/developers/reference",
    html: "developers/reference/index.html",
    md: "developers/reference.md",
    title: "API reference",
    blurb: "Every endpoint with parameters, request/response shapes, scopes, and a curl example.",
  },
  {
    route: "/developers/operations",
    html: "developers/operations/index.html",
    md: "developers/operations.md",
    title: "Operations",
    blurb: "Error shapes, cursor pagination, idempotent sends, rate limits, and CORS.",
  },
  {
    route: "/developers/recipes",
    html: "developers/recipes/index.html",
    md: "developers/recipes.md",
    title: "Recipes",
    blurb: "Worked examples: memo search with provenance, CI notifications, and a full bot-runtime agent loop.",
  },
  {
    route: "/developers/feature-requests",
    html: "developers/feature-requests/index.html",
    md: "developers/feature-requests.md",
    title: "Feature requests",
    blurb: "Where to ask for missing endpoints or scopes (GitHub issues on threahq/threa).",
  },
]

// ---------------------------------------------------------------------------
// HTML -> markdown
// ---------------------------------------------------------------------------

type DomNode = TurndownService.Node & {
  classList: { contains(c: string): boolean }
  querySelector(sel: string): DomNode | null
  querySelectorAll(sel: string): Iterable<DomNode>
  getAttribute(name: string): string | null
  textContent: string | null
  innerHTML: string
  parentNode: DomNode | null
  children: Iterable<DomNode>
  nodeName: string
}

const hasClass = (node: TurndownService.Node, cls: string) => (node as DomNode).classList?.contains(cls) ?? false

const qsa = (el: DomNode, sel: string): DomNode[] => Array.from(el.querySelectorAll(sel)) as DomNode[]
const childrenWithClass = (el: DomNode, cls: string): DomNode[] =>
  (Array.from(el.children) as DomNode[]).filter((c) => c.classList?.contains(cls))

/* A bare converter for table cells and other fragments, so the main service's
   block rules don't recurse into themselves. */
const inline = new TurndownService({ codeBlockStyle: "fenced" })
inline.remove("button")
const cellText = (cell: DomNode) => inline.turndown(cell.innerHTML).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()

function createConverter(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  })
  td.remove("script")
  td.remove("style")
  td.remove("button")

  // Decorative page eyebrow ("Developers", "Reference", …) — noise in markdown.
  td.addRule("eyebrow", {
    filter: (node) => node.nodeName === "P" && hasClass(node, "eyebrow"),
    replacement: () => "",
  })

  // Code samples: use the raw template (with {{tokens}}) rather than the
  // rendered <pre>, whose token chips are empty until the playground fills them.
  td.addRule("pg-block", {
    filter: (node) => hasClass(node, "pg-block"),
    replacement: (_content, node) => {
      const el = node as DomNode
      const template = el.querySelector("[data-template]")?.getAttribute("data-template") ?? ""
      const lang =
        el
          .querySelector("pre")
          ?.getAttribute("class")
          ?.match(/lang-([\w-]+)/)?.[1] ?? ""
      const label = el.querySelector(".pg-lang")?.textContent?.trim()
      const caption = label && label !== lang ? `*${label}:*\n\n` : ""
      return `\n\n${caption}\`\`\`${lang}\n${template}\n\`\`\`\n\n`
    },
  })

  // Callout boxes -> blockquotes.
  td.addRule("note", {
    filter: (node) => node.nodeName === "DIV" && hasClass(node, "note"),
    replacement: (content) => {
      const lines = content.trim().split("\n")
      // The leading <strong> is the callout's title; set it off from the body.
      if (lines[0]?.startsWith("**")) lines[0] = lines[0].replace(/^(\*\*[^*]+\*\*) ?/, "$1 — ")
      return `\n\n${lines.map((l) => `> ${l}`).join("\n")}\n\n`
    },
  })

  // Key-type cards: the "Use it when" strong runs straight into the text
  // (spacing is CSS), so insert the separator markdown needs.
  td.addRule("keytype-use", {
    filter: (node) => node.nodeName === "DIV" && hasClass(node, "use"),
    replacement: (content) => `\n\n${content.trim().replace(/^\*\*([^*]+)\*\*\s*/, "**$1:** ")}\n\n`,
  })

  // Plain docs tables -> GFM pipe tables.
  td.addRule("docs-table", {
    filter: (node) => node.nodeName === "TABLE",
    replacement: (_content, node) => {
      const el = node as DomNode
      const headers = qsa(el, "thead th").map(cellText)
      const rows = qsa(el, "tbody tr").map((tr) => `| ${qsa(tr, "td").map(cellText).join(" | ")} |`)
      return `\n\n| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.join("\n")}\n\n`
    },
  })

  // API reference: schema property trees -> nested bullet lists.
  td.addRule("api-props", {
    filter: (node) => node.nodeName === "DIV" && hasClass(node, "api-props"),
    replacement: (_content, node) => `\n\n${renderProps(node as DomNode, 0)}\n\n`,
  })

  // API reference: "VERB /path" header div -> a real heading.
  td.addRule("api-op-head", {
    filter: (node) => node.nodeName === "DIV" && hasClass(node, "api-op-head"),
    replacement: (_content, node) => {
      const el = node as DomNode
      const method = el.querySelector(".api-method")?.textContent?.trim() ?? ""
      const path = el.querySelector(".api-path")?.textContent?.trim() ?? ""
      return `\n\n### ${method} ${path}\n\n`
    },
  })

  // The op's summary h3 would compete with the heading above; make it bold text.
  td.addRule("api-op-title", {
    filter: (node) => node.nodeName === "H3" && hasClass(node, "api-op-title"),
    replacement: (content) => `\n\n**${content.trim()}**\n\n`,
  })

  // Required scopes line.
  td.addRule("api-scopes", {
    filter: (node) => node.nodeName === "P" && hasClass(node, "api-scopes"),
    replacement: (_content, node) => {
      const el = node as DomNode
      const scopes = qsa(el, "code.api-scope").map((c) => `\`${c.textContent?.trim()}\``)
      return `\n\nRequired scope: ${scopes.length ? scopes.join(", ") : "none — any valid key"}\n\n`
    },
  })

  // Headings inside list items (the quickstart steps) break list rendering;
  // demote them to bold text.
  td.addRule("li-heading", {
    filter: (node) => {
      if (!/^H[2-6]$/.test(node.nodeName)) return false
      for (let p = (node as DomNode).parentNode; p; p = p.parentNode) {
        if (p.nodeName === "LI") return true
      }
      return false
    },
    replacement: (content) => `**${content.trim()}**\n\n`,
  })

  return td
}

/* SchemaTable trees: each property renders as a bullet with its type, required
   flag, constraints, and description; nested shapes indent. */
function renderProps(propsEl: DomNode, depth: number): string {
  const indent = "  ".repeat(depth)
  const lines: string[] = []
  for (const prop of childrenWithClass(propsEl, "api-prop")) {
    // Only this property's own head/note/desc — querySelector on the subtree
    // would steal a nested child property's note.
    const head = childrenWithClass(prop, "api-prop-head")[0]
    const name = head?.querySelector(".api-prop-name")?.textContent?.trim() ?? ""
    const type = head?.querySelector(".api-prop-type")?.textContent?.trim() ?? ""
    const required = head?.querySelector(".api-req") ? ", required" : ""
    const note = childrenWithClass(prop, "api-prop-note")[0]?.textContent?.trim()
    const desc = childrenWithClass(prop, "api-prop-desc")[0]?.textContent?.trim()
    const detail = [note, desc].filter(Boolean).join(". ")
    lines.push(`${indent}- \`${name}\` (${type}${required})${detail ? ` — ${detail}` : ""}`)
    const nest = childrenWithClass(prop, "api-nest")[0]
    const nested = nest && childrenWithClass(nest, "api-props")[0]
    if (nested) lines.push(renderProps(nested, depth + 1))
  }
  return lines.join("\n")
}

/* Internal /developers links point at the .md mirrors so an agent following
   them stays in markdown; every other root-relative link becomes absolute. */
function rewriteLinks(markdown: string): string {
  return markdown.replace(/\]\((\/[^)#\s]*)(#[^)\s]*)?\)/g, (_m, path: string, hash = "") => {
    const page = PAGES.find((p) => p.route === path)
    if (page) return `](${SITE}/${page.md}${hash})`
    return `](${SITE}${path}${hash})`
  })
}

function pageToMarkdown(page: Page): string {
  const html = readFileSync(dist(page.html), "utf8")
  // The wrapper comes from DocsLayout.astro's <article class="docs-article">
  // (plus variant classes like is-wide); this extraction is what breaks if
  // that layout renames or re-nests it.
  const article = html.match(/<article class="docs-article[^"]*">([\s\S]*?)<\/article>/)?.[1]
  if (!article) {
    throw new Error(`No <article class="docs-article…"> in ${page.html} — did DocsLayout.astro change its wrapper?`)
  }

  let md = createConverter().turndown(article)
  md = md.replace(/\{\{(baseUrl|workspaceId|apiKey)\}\}/g, (_m, name: string) => TOKEN_DEFAULTS[name])
  // Inside code samples the spec's single-brace path param should be a runnable
  // placeholder too; headings and prose keep the {workspaceId} template form.
  md = md
    .split("```")
    .map((seg, i) =>
      i % 2 === 1 ? seg.replace(/\/workspaces\/\{workspaceId\}/g, `/workspaces/${TOKEN_DEFAULTS.workspaceId}`) : seg
    )
    .join("```")
  md = rewriteLinks(md)
  md = md.replace(/\n{3,}/g, "\n\n").trim()

  const header = [
    "---",
    `source: ${SITE}${page.route}`,
    `notes: Markdown mirror generated from the page above. YOUR_WORKSPACE_ID is the ws_… id in the app URL after /w/; YOUR_API_KEY is a key from Settings > API keys.`,
    "---",
  ].join("\n")
  return `${header}\n\n${md}\n`
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const missing = PAGES.filter((p) => !existsSync(dist(p.html)))
if (missing.length) {
  throw new Error(`Built pages missing from dist (run astro build first): ${missing.map((p) => p.html).join(", ")}`)
}

// The inverse direction: a docs page added to src/pages/developers/ without a
// PAGES entry would silently ship with no markdown mirror or llms.txt listing.
const builtPages = readdirSync(dist("developers"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `developers/${e.name}/index.html`)
  .concat("developers/index.html")
const unlisted = builtPages.filter((html) => !PAGES.some((p) => p.html === html))
if (unlisted.length) {
  throw new Error(`Docs pages built without a PAGES entry in scripts/build-llms.ts: ${unlisted.join(", ")}`)
}

const mirrors = PAGES.map((page) => {
  const md = pageToMarkdown(page)
  writeFileSync(dist(page.md), md)
  return { page, md }
})

const llmsTxt = `# Threa

> Threa is AI-powered knowledge chat: conversations become preserved, searchable memos
> (decisions, context, provenance) that both Threa's own assistant and your agents can
> read. The public REST API lives at https://app.threa.io under
> /api/v1/workspaces/{workspaceId}/… and authenticates every request with
> "Authorization: Bearer <api key>". Keys are created in the app (Settings > API keys)
> and carry scopes; GET /me verifies a key with no scope required.

There is no MCP server yet — agents integrate over the REST API and the pull-based
bot-runtime protocol (no inbound ports needed). All docs below are markdown.

## Docs

${PAGES.map((p) => `- [${p.title}](${SITE}/${p.md}): ${p.blurb}`).join("\n")}

## Machine-readable

- [OpenAPI 3.0 spec](${SITE}/openapi.json): the canonical contract — every endpoint, schema, scope, and error
- [Full docs in one file](${SITE}/llms-full.txt): all pages above concatenated

## Optional

- [About Threa](${SITE}/about): what the product is and how memos work
`

writeFileSync(dist("llms.txt"), llmsTxt)

// One fetch for everything: the mirrors with their front matter swapped for a
// plain source line, so the only `---` lines are the page separators.
const llmsFull = [
  `# Threa developer docs (full)\n\n> Concatenation of every page under ${SITE}/developers, generated at build.\n> The canonical API contract is the OpenAPI spec: ${SITE}/openapi.json\n> Placeholders: YOUR_WORKSPACE_ID is the ws_… id in the app URL after /w/; YOUR_API_KEY is a key from Settings > API keys.`,
  ...mirrors.map(({ page, md }) => `*Source: ${SITE}${page.route}*\n\n${md.replace(/^---\n[\s\S]*?\n---\n\n/, "")}`),
].join("\n\n---\n\n")
writeFileSync(dist("llms-full.txt"), llmsFull)

console.log(
  `Wrote ${mirrors.length} markdown mirrors, llms.txt, llms-full.txt (${(llmsFull.length / 1024).toFixed(0)} KB full)`
)
