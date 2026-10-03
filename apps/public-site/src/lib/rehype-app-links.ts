import { parseAppLinkHref } from "@threahq/types"

interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/**
 * Turns the guide's `app:` hrefs into chips that open the Threa app. The site
 * holds no workspace id, so every chip points at the app origin, which lands
 * the reader in their own workspace; `data-app-link` names the destination.
 * An href the app would not recognise fails the build instead of shipping a
 * dead link.
 */
export function rehypeAppLinks({ appUrl }: { appUrl: string }) {
  const visit = (node: HastNode): void => {
    const href = node.type === "element" && node.tagName === "a" ? node.properties?.href : undefined
    if (typeof href === "string" && href.startsWith("app:")) {
      if (!parseAppLinkHref(href)) throw new Error(`Guide link "${href}" is not a destination the app understands`)
      node.properties = {
        ...node.properties,
        href: appUrl,
        className: ["app-link"],
        dataAppLink: href.slice("app:".length),
        title: "Opens in the Threa app",
      }
    }
    node.children?.forEach(visit)
  }
  return visit
}
