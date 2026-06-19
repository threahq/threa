/**
 * Cloudflare Pages Function for /assets/* (auto-scoped: wrangler generates a
 * _routes.json that only invokes this for asset paths; navigations bypass it).
 *
 * The problem it fixes: when a content-hashed chunk no longer exists on the live
 * deployment, the SPA `_redirects` fallback (`/* /index.html 200`) answers the
 * /assets/*.js request with index.html — HTML, status 200 — and `public/_headers`
 * stamps /assets/* `immutable, max-age=1yr`. The browser (and the CF edge) then
 * cache that HTML-as-JS for a year, so the tab's dynamic import() keeps parsing
 * HTML as a module and stays bricked until the cache expires. Clearing the SW and
 * CacheStorage can't evict the edge copy.
 *
 * Here we run the normal asset pipeline via next(): a real asset comes back with
 * its own immutable headers untouched. Only when the pipeline falls through to
 * the HTML shell (the asset is gone) do we replace it with a real 404 marked
 * no-store, so import() fails cleanly and transiently — recoverable on the next
 * load instead of permanently poisoned.
 */
interface AssetsFunctionContext {
  request: Request
  next: () => Promise<Response>
}

export async function onRequest(context: AssetsFunctionContext): Promise<Response> {
  const response = await context.next()

  // Real assets are application/javascript, text/css, image/*, font/* — never
  // HTML. An HTML response on an /assets/* path means the static asset was
  // missing and the SPA fallback served index.html.
  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/html")) {
    return new Response("Asset not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }

  return response
}
