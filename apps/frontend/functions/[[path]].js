const FILE_EXTENSION_RE = /\/[^/]+\.[^/]+$/

function isHtmlNavigation(request) {
  const accept = request.headers.get("accept") ?? ""
  return accept.toLowerCase().includes("text/html")
}

function isExtensionlessPath(pathname) {
  return !FILE_EXTENSION_RE.test(pathname)
}

export function shouldServeSpaForStaticMiss(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  const url = new URL(request.url)
  return isHtmlNavigation(request) && isExtensionlessPath(url.pathname)
}

export async function onRequest(context) {
  const request = context.request
  if (request.method !== "GET" && request.method !== "HEAD") return context.next()

  const staticResponse = await context.env.ASSETS.fetch(request)
  if (staticResponse.status !== 404) return staticResponse

  if (!shouldServeSpaForStaticMiss(request)) return staticResponse

  return context.env.ASSETS.fetch(new Request(new URL("/", request.url), request))
}
