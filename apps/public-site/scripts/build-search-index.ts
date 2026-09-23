/*
 * Post-build step: the docs search index, read from the built pages so it
 * names exactly what they render: each page, its h2/h3 headings, every API
 * operation, and every request/response field row.
 *
 * Writes dist/developers/search-index.json, which the search UI fetches the
 * first time it opens.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import type { SearchEntry } from "../src/lib/search"

const distDir = fileURLToPath(new URL("../dist", import.meta.url))
const docsDir = join(distDir, "developers")

// Older dated API versions render the same operations as the current
// reference; indexing them would list every endpoint twice.
const isOlderReference = (file: string) => /^reference\/[^/]+\/index\.html$/.test(relative(docsDir, file))

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return htmlFiles(path)
    return e.name === "index.html" ? [path] : []
  })
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(Number.parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10))
    return ENTITIES[e] ?? m
  })
const clean = (s: string) => decode(s).replace(/\s+/g, " ").trim()

const FIELD_SECTIONS: Record<string, { param?: string; body?: string; word: string }> = {
  path: { param: "Path parameter", word: "path parameters" },
  query: { param: "Query parameter", word: "query parameters" },
  body: { body: "request body", word: "request body" },
  response: { body: "response", word: "response" },
}

/* A response whose data is one of these resources (it carries an `id`) names
   its fields after it: "Field on Message" rather than the endpoint's envelope.
   The resource is the last of these segments in the operation's path. */
const RESOURCES: Record<string, string> = {
  messages: "Message",
  attachments: "Attachment",
  streams: "Stream",
  conversations: "Conversation",
  users: "User",
  labels: "Label",
  delegations: "Delegation",
  decisions: "Decision",
  bots: "Bot",
}

const resourceOf = (path: string) =>
  path
    .split("/")
    .reverse()
    .map((segment) => RESOURCES[segment])
    .find(Boolean)

interface Opened {
  tag: string
  id: string | null
  className: string | null
  section: string | null
}

/* Collects the text of the element each handler is attached to, delivering it
   once the element closes. The element itself is only readable while its start
   tag is being handled, so its attributes are copied then. */
function captureText(onDone: (text: string, el: Opened) => void) {
  let buf = ""
  return {
    element(el: HTMLRewriterTypes.Element) {
      buf = ""
      const opened: Opened = {
        tag: el.tagName,
        id: el.getAttribute("id"),
        className: el.getAttribute("class"),
        section: el.getAttribute("data-section"),
      }
      el.onEndTag(() => onDone(clean(buf), opened))
    },
    text(chunk: HTMLRewriterTypes.Text) {
      buf += chunk.text
    },
  }
}

async function indexPage(file: string): Promise<SearchEntry[]> {
  const rel = relative(docsDir, file)
  const route = rel === "index.html" ? "/developers" : `/developers/${rel.replace(/\/index\.html$/, "")}`
  const entries: SearchEntry[] = []
  const unlinked: string[] = []

  let navGroup = ""
  let pageGroup = ""
  let pageLabel = ""
  let h1 = ""
  const sectionLabels = new Map<string, string>()
  let lastH2 = ""
  let op: {
    id: string
    method: string
    summary: string
    fields: { id: string; entry: Omit<SearchEntry, "where">; where: (resource?: string) => string }[]
  } | null = null

  const rewriter = new HTMLRewriter()
    .on(
      "aside.docs-side .docs-side-group > h4",
      captureText((text) => (navGroup = text))
    )
    .on(
      "aside.docs-side a.current",
      captureText((text) => {
        pageGroup = navGroup
        pageLabel = text
      })
    )
    .on(
      "aside.docs-side a[data-section]",
      captureText((text, el) => sectionLabels.set(el.section ?? "", text))
    )
    .on(
      "article.docs-article h1",
      captureText((text) => (h1 = text.replace(/\.$/, "")))
    )
    .on(
      "article.docs-article h2, article.docs-article h3",
      captureText((text, el) => {
        if (el.className?.includes("api-op-title")) return
        const id = el.id
        if (!id) {
          unlinked.push(text)
          return
        }
        const isH2 = el.tag === "h2"
        if (isH2) lastH2 = text
        entries.push({
          kind: "heading",
          title: text,
          url: `${route}#${id}`,
          where: isH2 ? `Section in ${pageLabel}` : `Section in ${pageLabel} / ${lastH2}`,
          context: isH2 ? [pageLabel] : [pageLabel, lastH2],
        })
      })
    )
    .on("article.docs-article section.api-op", {
      element(el) {
        const id = el.getAttribute("id")
        if (!id) throw new Error(`${rel}: an operation section has no id to link to`)
        op = { id, method: "", summary: "", fields: [] }
        el.onEndTag(() => {
          const current = op!
          const label = sectionLabels.get(current.id)
          if (!label) throw new Error(`${rel}: operation #${current.id} has no sidebar entry to name its path`)
          const path = label.slice(label.indexOf(" ") + 1)
          const resource = current.fields.some((f) => f.id === `${current.id}.response.data.id`)
            ? resourceOf(path)
            : undefined
          for (const f of current.fields) entries.push({ ...f.entry, where: f.where(resource) })
          entries.push({
            kind: "operation",
            title: current.summary || label,
            url: `${route}#${current.id}`,
            where: `Endpoint in ${lastH2}`,
            aliases: [current.id, label],
            context: [lastH2],
            method: current.method,
            path,
          })
          op = null
        })
      },
    })
    .on(
      "section.api-op .api-method",
      captureText((text) => (op!.method = text))
    )
    .on(
      "section.api-op h3.api-op-title",
      captureText((text) => (op!.summary = text))
    )
    .on("section.api-op .api-prop[id]", {
      element(el) {
        const current = op!
        const id = el.getAttribute("id")!
        const [section, ...path] = id.slice(current.id.length + 1).split(".")
        const kind = FIELD_SECTIONS[section]
        if (!id.startsWith(`${current.id}.`) || !kind || path.length === 0) {
          throw new Error(`${rel}: field row #${id} doesn't follow <operation>.<section>.<path>`)
        }
        const name = path[path.length - 1]
        const parent = path.slice(0, -1).join(".")
        const summary = current.summary || current.id
        const owner = path.length > 1 ? path[path.length - 2] : ""
        const where = (resource?: string) => {
          if (kind.param) return `${kind.param} of ${summary}`
          if (resource && parent === "data") return `Field on ${resource} in ${summary}`
          if (owner && owner !== "data") return `Field on ${owner} in the ${summary} ${kind.body}`
          return `Field in the ${summary} ${kind.body}`
        }
        current.fields.push({
          id,
          where,
          entry: {
            kind: "field",
            title: name,
            url: `${route}#${id}`,
            aliases: parent ? [path.join(".")] : undefined,
            context: [lastH2, summary, current.id, kind.word, parent].filter(Boolean),
          },
        })
      },
    })

  await rewriter.transform(new Response(readFileSync(file, "utf8"))).text()

  if (!pageLabel) throw new Error(`${rel}: no current sidebar entry, so the page has no name to index`)
  if (!pageGroup) throw new Error(`${rel}: the current sidebar entry has no group heading above it`)
  if (unlinked.length) {
    throw new Error(`${rel}: headings without an id can't be linked from search: ${unlinked.join(", ")}`)
  }
  const page: SearchEntry = {
    kind: "page",
    title: pageLabel,
    url: route,
    where: `Page in ${pageGroup}`,
    aliases: h1 && h1 !== pageLabel ? [h1] : undefined,
    context: [pageGroup],
  }
  return [page, ...entries]
}

const files = htmlFiles(docsDir)
  .filter((f) => !isOlderReference(f))
  .sort()
const entries = (await Promise.all(files.map(indexPage))).flat()
const json = JSON.stringify(entries)
writeFileSync(join(docsDir, "search-index.json"), json)

const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {})
console.log(
  `Wrote search index: ${entries.length} entries (${Object.entries(counts)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ")}), ${(json.length / 1024).toFixed(0)} KB`
)
