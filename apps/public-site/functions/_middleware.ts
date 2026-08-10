/*
 * Markdown content negotiation for agents.
 *
 * `Accept: text/markdown` on any page route serves that page's markdown mirror
 * (built by scripts/build-llms.ts) instead of the HTML; browsers, which never
 * send it, keep getting HTML. The mirrors are generated from the same HTML the
 * site ships, so the two representations cannot drift.
 *
 * public/_routes.json narrows this Function to the page routes, so static
 * assets are still served straight off the CDN with no Worker invocation.
 */

interface PagesContext {
  request: Request
  next: (input?: Request) => Promise<Response>
}

const MARKDOWN_TYPE = "text/markdown; charset=utf-8"

/* Every mirror opens with this front matter (scripts/build-llms.ts writes it,
   and fails its build if one doesn't). It is what tells a real mirror apart
   from Pages' answer to a missing asset, which is a 200 HTML page — status
   alone would relabel that page as markdown, and the asset server's own
   content-type would put the whole feature at the mercy of how Pages happens
   to type a .md file. */
export const MIRROR_PREFIX = "---\nsource: "

/* Accepted only when text/markdown is listed at a non-zero q. A browser sends
   text/html,…,*\/*, so the wildcard alone must not trigger markdown. */
export function wantsMarkdown(accept: string): boolean {
  return accept.split(",").some((entry) => {
    const [type, ...params] = entry.trim().toLowerCase().split(";")
    if (type !== "text/markdown") return false
    const q = params.map((p) => p.replace(/\s/g, "")).find((p) => p.startsWith("q="))
    return q === undefined || Number.parseFloat(q.slice(2)) > 0
  })
}

/* /about -> /about.md; /developers -> /developers/index.md (build-llms.ts
   names the index mirror after its HTML file, every other after its route). */
export function mirrorCandidates(pathname: string): string[] {
  const base = pathname.replace(/\/+$/, "")
  if (base === "") return ["/index.md"]
  if (base.endsWith(".md")) return []
  return [`${base}.md`, `${base}/index.md`]
}

/* Vary on the HTML path too: without it a cache can hand a stored HTML body to
   a request that asked for markdown, and vice versa. */
function varyOnAccept(response: Response): Response {
  const out = new Response(response.body, response)
  out.headers.append("Vary", "Accept")
  return out
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, next } = context
  const isRead = request.method === "GET" || request.method === "HEAD"
  if (!isRead || !wantsMarkdown(request.headers.get("accept") ?? "")) {
    return varyOnAccept(await next())
  }

  const url = new URL(request.url)
  for (const candidate of mirrorCandidates(url.pathname)) {
    const mirror = await next(new Request(new URL(candidate, url).href, { method: "GET" }))
    if (!mirror.ok) continue
    const markdown = await mirror.text()
    // A route with no mirror (a versioned API reference, say) falls back to HTML.
    if (!markdown.startsWith(MIRROR_PREFIX)) continue

    // Start from the asset's own headers so the Link relations _headers applied
    // to it survive: an agent that negotiates markdown is exactly the caller
    // those relations exist for, and a fresh Headers would drop them.
    const headers = new Headers(mirror.headers)
    headers.set("Content-Type", MARKDOWN_TYPE)
    // Estimate, the conventional ~4 chars/token; no tokenizer at the edge.
    headers.set("x-markdown-tokens", String(Math.ceil(markdown.length / 4)))
    headers.set("Vary", "Accept")
    // Both described the .md asset as its own response, not this one.
    headers.delete("Content-Length")
    headers.delete("ETag")

    return new Response(request.method === "HEAD" ? null : markdown, { status: 200, headers })
  }

  return varyOnAccept(await next())
}
