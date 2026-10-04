import { APP_LINK_GO_ROUTE, APP_LINK_SCHEME, parseAppLinkHref } from "@threahq/types"

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * Turns the guide's `app:` hrefs into chips that open the Threa app. The site
 * holds no workspace id, so every chip points at the app's `/go/<place>` route,
 * which opens the place in the reader's own workspace.
 * An href the app would not recognise fails the build instead of shipping a
 * dead link.
 */
export function rehypeAppLinks({ appUrl }: { appUrl: string }) {
  const visit = (node: HastNode): void => {
    const href = node.type === "element" && node.tagName === "a" ? node.properties?.href : undefined
    if (typeof href === "string" && href.startsWith(APP_LINK_SCHEME)) {
      if (!parseAppLinkHref(href)) throw new Error(`Guide link "${href}" is not a destination the app understands`)
      node.properties = {
        ...node.properties,
        href: `${appUrl}${APP_LINK_GO_ROUTE}/${href.slice(APP_LINK_SCHEME.length)}`,
        className: ["app-link"],
        title: "Opens your Threa workspace",
      }
    }
    node.children?.forEach(visit)
  }
  return visit
}
