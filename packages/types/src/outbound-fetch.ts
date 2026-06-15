/**
 * Outbound HTTP identity shared by every Threa service that fetches third-party URLs
 * (link-preview metadata extraction, the agent read-url tool, …).
 *
 * The `+`-prefixed contact URL is the load-bearing part. It is the long-standing polite-crawler
 * convention (Googlebot's `+http://www.google.com/bot.html`, facebookexternalhit, Slackbot), and
 * several large sites — Amazon notably — gate their bot detection on it: a bare token like
 * `Threa/1.0`, or even a browser-like UA coming from a datacenter IP, is handed a metadata-less
 * captcha page, while the same request carrying `(+https://…)` is served the real HTML.
 *
 * Every outbound fetcher must build its User-Agent through {@link threaFetchUserAgent} rather than
 * hand-rolling a string, so a new fetch path can't silently reintroduce the bare-UA form and lose
 * previews. This is the single source of truth (INV-33) for that identity.
 */
export const THREA_BOT_CONTACT_URL = "https://threa.io/bot"

/**
 * Build a polite-crawler User-Agent for outbound third-party fetches, tagged with the calling
 * component (e.g. "Link Preview", "Agent Reader") so site operators reading their logs can tell
 * Threa's surfaces apart. The `+`-prefixed contact URL is always present — see the module comment.
 */
export function threaFetchUserAgent(component: string): string {
  return `Threa/1.0 (${component}; +${THREA_BOT_CONTACT_URL})`
}

/**
 * User-Agent for Reddit fetches.
 *
 * Reddit serves a "Please wait for verification" anti-bot interstitial to generic crawler UAs —
 * even the polite {@link threaFetchUserAgent} form whose `+`-prefixed contact URL gets us past
 * Amazon-class gates. Reddit instead allowlists the well-known social link-unfurl crawlers (this is
 * how Slack/Discord/iMessage show Reddit cards), so Reddit requests go out under a recognized
 * crawler token to receive the real server-rendered OpenGraph HTML. Mirrors the `Twitterbot/1.0`
 * precedent the link-preview worker already uses for X image fetches.
 */
export const REDDIT_CRAWLER_USER_AGENT = "facebookexternalhit/1.1"

/**
 * Detect Reddit URLs (incl. subdomains and the `redd.it` shortener) so every outbound fetcher can
 * route them through {@link REDDIT_CRAWLER_USER_AGENT} and apply the same anti-bot handling.
 */
export function isRedditUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === "reddit.com" || hostname.endsWith(".reddit.com") || hostname === "redd.it"
  } catch {
    return false
  }
}

/**
 * Resolve the User-Agent for an outbound fetch: the recognized crawler token for Reddit hosts,
 * otherwise the polite component-tagged {@link threaFetchUserAgent}. This is the single entry point
 * outbound fetchers should call so Reddit handling can't drift between callers (INV-33).
 */
export function resolveFetchUserAgent(component: string, url: string): string {
  return isRedditUrl(url) ? REDDIT_CRAWLER_USER_AGENT : threaFetchUserAgent(component)
}
