import { linkFaviconHost } from "@threahq/types"

export type ExternalLinkProvider = "github" | "linear"

export interface ExternalLinkDescription {
  /** The key the backend caches this link's favicon under. */
  faviconHost: string
  provider: ExternalLinkProvider | null
  compactLabel: string | null
}

const GITHUB_ITEM_PATH = /^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)\/?$/
const LINEAR_ISSUE_PATH = /^\/[^/]+\/issue\/([a-z0-9]+-\d+)(?:\/[^/]+)?\/?$/i

export function externalLinkProviderForHost(hostname: string): ExternalLinkProvider | null {
  const host = hostname.toLowerCase()
  if (host === "github.com" || host === "www.github.com") return "github"
  if (host === "linear.app" || host === "www.linear.app") return "linear"
  return null
}

function compactLabelFor(provider: ExternalLinkProvider | null, url: URL): string | null {
  if (url.search || url.hash) return null
  if (provider === "github") {
    const match = GITHUB_ITEM_PATH.exec(url.pathname)
    return match ? `${match[1]}/${match[2]}#${match[3]}` : null
  }
  if (provider === "linear") {
    const match = LINEAR_ISSUE_PATH.exec(url.pathname)
    return match ? match[1]!.toUpperCase() : null
  }
  return null
}

export function describeExternalLink(href: string): ExternalLinkDescription | null {
  const faviconHost = linkFaviconHost(href)
  if (!faviconHost) return null
  const url = new URL(href)
  const provider = externalLinkProviderForHost(url.hostname)
  return { faviconHost, provider, compactLabel: compactLabelFor(provider, url) }
}
