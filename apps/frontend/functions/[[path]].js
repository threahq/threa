const SPA_ROUTES = new Set(["/login", "/workspaces", "/add-account", "/share"])

export function shouldServeSpa(pathname) {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  return SPA_ROUTES.has(normalized) || normalized.startsWith("/w/") || normalized.startsWith("/join/")
}

export async function onRequest(context) {
  const request = context.request
  if (request.method !== "GET" && request.method !== "HEAD") return context.next()

  const url = new URL(request.url)
  if (!shouldServeSpa(url.pathname)) return context.next()

  return context.env.ASSETS.fetch(new Request(new URL("/", url), request))
}
