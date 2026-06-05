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
