import { logger } from "../logger"

export const WebSearchEngineNames = {
  EXA: "exa",
  SERPER: "serper",
} as const

export type WebSearchEngineName = (typeof WebSearchEngineNames)[keyof typeof WebSearchEngineNames]

/**
 * Where a result's text came from. A `listed` result is Google's listing today:
 * the title is current, the snippet may not be. A `stored` result is a crawled
 * copy that can be weeks old. `both` is one page both kinds found.
 */
export type WebPageSeen = "listed" | "stored" | "both"

export interface WebPage {
  title: string
  url: string
  content: string
  seen: WebPageSeen
  date?: string
}

export interface WebSearchEngine {
  name: WebSearchEngineName
  search(query: string, opts: { maxResults: number; signal: AbortSignal }): Promise<WebPage[]>
}

const EXA_TEXT_CHARACTERS = 3000

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`${new URL(url).host} ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  return (await response.json()) as any
}

export function createExaEngine(apiKey: string): WebSearchEngine {
  return {
    name: WebSearchEngineNames.EXA,
    search: async (query, { maxResults, signal }) => {
      const data = await postJson(
        "https://api.exa.ai/search",
        { "x-api-key": apiKey },
        { query, numResults: maxResults, contents: { text: { maxCharacters: EXA_TEXT_CHARACTERS } } },
        signal
      )
      return (data.results ?? []).map(
        (r: any): WebPage => ({
          title: r.title || r.url,
          url: r.url,
          content: r.text ?? "",
          seen: "stored",
          ...(r.publishedDate ? { date: String(r.publishedDate).slice(0, 10) } : {}),
        })
      )
    },
  }
}

export function createSerperEngine(apiKey: string): WebSearchEngine {
  return {
    name: WebSearchEngineNames.SERPER,
    search: async (query, { maxResults, signal }) => {
      const data = await postJson(
        "https://google.serper.dev/search",
        { "X-API-KEY": apiKey },
        { q: query, num: maxResults },
        signal
      )
      return (data.organic ?? []).map(
        (r: any): WebPage => ({
          title: r.title || r.link,
          url: r.link,
          content: r.snippet ?? "",
          seen: "listed",
          ...(r.date ? { date: String(r.date) } : {}),
        })
      )
    },
  }
}

export interface WebSearchEngineKeys {
  exa?: string
  serper?: string
}

/**
 * One engine per key that is set. With neither key there is no `web_search`,
 * and with one the other is logged as missing: Serper alone has only snippets,
 * Exa alone only stored copies.
 */
export function createWebSearchEngines(keys: WebSearchEngineKeys): WebSearchEngine[] {
  const engines = [
    ...(keys.exa ? [createExaEngine(keys.exa)] : []),
    ...(keys.serper ? [createSerperEngine(keys.serper)] : []),
  ]
  if (engines.length === 1) {
    const missing = keys.exa ? WebSearchEngineNames.SERPER : WebSearchEngineNames.EXA
    logger.warn({ missing }, "Web search runs on one engine, the other has no API key")
  }
  return engines
}

// LinkedIn answers one profile at se.linkedin.com for Google and www.linkedin.com
// for Exa, so a leading www. or two-letter label is dropped before comparing. The
// two-letter label only goes when a path follows: ai.google.dev is not google.dev.
function sameAddress(url: string): string {
  return url.replace(/^https?:\/\/(www\.|[a-z]{2}\.(?=[^/]+\.[^/]+\/[^?#]))?/, "").replace(/[/?#]+$/, "")
}

/**
 * Today's listings first, then stored copies. A page both kinds found becomes
 * one entry with today's title over the stored text: as two entries the stale
 * stored copy wins, because it has the detail.
 */
export function combineWebPages(all: WebPage[]): WebPage[] {
  const pages: WebPage[] = []
  for (const page of all) {
    if (!pages.some((kept) => kept.seen === page.seen && sameAddress(kept.url) === sameAddress(page.url))) {
      pages.push(page)
    }
  }
  const listed = new Map(pages.filter((page) => page.seen === "listed").map((page) => [sameAddress(page.url), page]))
  const merged = new Set<string>()
  const combined = pages.map((page): WebPage => {
    const twin = page.seen === "stored" ? listed.get(sameAddress(page.url)) : undefined
    if (!twin) return page
    merged.add(sameAddress(page.url))
    return { ...page, title: twin.title, seen: "both" }
  })
  const rank: Record<WebPageSeen, number> = { listed: 0, both: 1, stored: 2 }
  return combined
    .filter((page) => !(page.seen === "listed" && merged.has(sameAddress(page.url))))
    .sort((a, b) => rank[a.seen] - rank[b.seen])
}

/** How old a result's text may be, stated so the model can't read past it. */
export function describeWebPageAge(page: WebPage, now: Date): string {
  const today = now.toISOString().slice(0, 10)
  if (page.seen === "listed") {
    return `Google's listing on ${today}${page.date ? `, page dated ${page.date}` : ""}. The title is current, the text under it may not be`
  }
  if (page.seen === "both") {
    return `Google lists this page on ${today} under the title above. The text is a stored copy${page.date ? ` dated ${page.date}` : " of unknown age"}; where it disagrees with the title, the title is current`
  }
  return page.date ? `stored copy of the page, dated ${page.date}` : "stored copy of the page, age unknown"
}

/**
 * Runs every engine at once. One engine failing is logged and the rest carry
 * the search; every engine failing is the search failing.
 */
export async function searchWebEngines(
  engines: WebSearchEngine[],
  query: string,
  opts: { maxResults: number; signal: AbortSignal }
): Promise<WebPage[]> {
  const settled = await Promise.allSettled(engines.map((engine) => engine.search(query, opts)))
  const failures = settled.flatMap((outcome, index) =>
    outcome.status === "rejected" ? [{ engine: engines[index]!.name, error: outcome.reason }] : []
  )
  if (failures.length === engines.length) {
    if (failures.length === 1) throw failures[0]!.error
    const reason = failures.map((f) => `${f.engine}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
    throw new Error(reason.join(" | "))
  }
  for (const failure of failures) {
    logger.warn({ engine: failure.engine, error: failure.error }, "Web search engine failed, continuing on the rest")
  }

  return combineWebPages(settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : [])))
}
