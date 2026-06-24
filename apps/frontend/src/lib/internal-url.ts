/**
 * Treat any link to our own origin as in-app navigation. Without this, a link
 * like `https://app.threa.io/w/.../s/...?m=msg_xxx` rendered inside the
 * installed PWA on Android hops to a Custom Tab (browser chrome, "open in
 * Firefox") because `target="_blank"` forces a new browsing context. Returns
 * the router path (`pathname + search + hash`) for a same-origin URL, or `null`
 * for an external one (or an unparseable href).
 */
export function resolveInternalAppPath(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}
