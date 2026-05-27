import { z } from "zod"
import * as dns from "dns/promises"
import * as ipaddr from "ipaddr.js"
import { NodeHtmlMarkdown } from "node-html-markdown"
import { AgentStepTypes } from "@threa/types"
import { logger } from "../logger"
import { defineAgentTool, type AgentToolResult } from "../runtime"

const ReadUrlSchema = z.object({
  url: z.string().url().describe("The URL of the web page to read"),
})

export type ReadUrlInput = z.infer<typeof ReadUrlSchema>

export interface ReadUrlResult {
  url: string
  title: string
  content: string
}

const MAX_CONTENT_LENGTH = 50000
const FETCH_TIMEOUT_MS = 30000
const MAX_REDIRECTS = 5

const nhm = new NodeHtmlMarkdown()

/**
 * Check if an IP address is private, reserved, or otherwise unsafe.
 * Uses ipaddr.js to handle all IP formats (IPv4, IPv6, mapped, various encodings).
 */
function isPrivateOrReservedIP(ip: string): boolean {
  try {
    const addr = ipaddr.parse(ip)
    const range = addr.range()

    // Block all non-unicast ranges
    const blockedRanges = [
      "unspecified", // 0.0.0.0, ::
      "loopback", // 127.0.0.0/8, ::1
      "private", // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
      "linkLocal", // 169.254.0.0/16, fe80::/10
      "multicast", // 224.0.0.0/4, ff00::/8
      "reserved", // Various reserved ranges
      "uniqueLocal", // fc00::/7 (IPv6 private)
      "ipv4Mapped", // ::ffff:0:0/96 - check the mapped IPv4
      "rfc6052", // 64:ff9b::/96 (NAT64)
      "rfc6145", // ::ffff:0:0:0/96
      "benchmarking", // 198.18.0.0/15
      "amt", // 192.52.193.0/24
      "as112", // 192.175.48.0/24
      "deprecated", // Various
      "orchid", // 2001:10::/28
      "6to4", // 2002::/16
      "teredo", // 2001::/32
    ]

    if (blockedRanges.includes(range)) {
      return true
    }

    // For IPv4-mapped IPv6 addresses, also check the embedded IPv4
    if (addr.kind() === "ipv6") {
      const ipv6 = addr as ipaddr.IPv6
      if (ipv6.isIPv4MappedAddress()) {
        const ipv4 = ipv6.toIPv4Address()
        return isPrivateOrReservedIP(ipv4.toString())
      }
    }

    return false
  } catch {
    // If we can't parse it, block it
    return true
  }
}

/**
 * Validate a URL for SSRF protection.
 * Returns error message if blocked, null if allowed.
 */
async function validateUrlWithDns(urlString: string): Promise<string | null> {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    return "Invalid URL format."
  }

  // Only allow HTTP(S)
  if (!["http:", "https:"].includes(url.protocol)) {
    return `Unsupported protocol: ${url.protocol}. Only HTTP and HTTPS are allowed.`
  }

  // Block internal hostname patterns (normalize trailing dot for FQDN)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
  if (hostname === "localhost") {
    return "Access to private or reserved IP addresses is not allowed."
  }
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".corp") ||
    hostname.endsWith(".lan")
  ) {
    return "Access to internal hostnames is not allowed."
  }

  // Remove IPv6 brackets if present
  const cleanHostname = hostname.replace(/^\[|\]$/g, "")

  // Check if hostname is already an IP address
  if (ipaddr.isValid(cleanHostname)) {
    if (isPrivateOrReservedIP(cleanHostname)) {
      return "Access to private or reserved IP addresses is not allowed."
    }
    return null
  }

  // Resolve DNS (both A and AAAA records) and validate ALL resolved IPs
  try {
    const [ipv4Result, ipv6Result] = await Promise.allSettled([
      dns.resolve4(cleanHostname),
      dns.resolve6(cleanHostname),
    ])

    const allAddresses: string[] = []
    if (ipv4Result.status === "fulfilled") allAddresses.push(...ipv4Result.value)
    if (ipv6Result.status === "fulfilled") allAddresses.push(...ipv6Result.value)

    // If no records found at all, fail closed
    if (allAddresses.length === 0) {
      logger.warn({ hostname: cleanHostname }, "DNS resolution returned no records")
      return "Unable to validate URL - no DNS records found."
    }

    for (const ip of allAddresses) {
      if (isPrivateOrReservedIP(ip)) {
        return "URL resolves to a private or reserved IP address."
      }
    }
  } catch (err) {
    // DNS resolution failed - fail closed for security
    logger.warn({ hostname: cleanHostname, error: err }, "DNS resolution failed, blocking request")
    return "Unable to validate URL - DNS resolution failed."
  }

  return null
}

/**
 * Fetch a URL with redirect validation.
 * Each redirect is validated for SSRF before following.
 */
async function fetchWithRedirectValidation(
  url: string,
  signal: AbortSignal,
  redirectCount = 0
): Promise<Response | { error: string }> {
  if (redirectCount > MAX_REDIRECTS) {
    return { error: `Too many redirects (max ${MAX_REDIRECTS})` }
  }

  const response = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Threa-Agent/1.0 (https://threa.app)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "manual", // Don't follow redirects automatically
  })

  // Handle redirects manually
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location")
    if (!location) {
      return { error: `Redirect response missing Location header` }
    }

    // Resolve relative URLs
    const redirectUrl = new URL(location, url).toString()

    // Validate redirect destination for SSRF
    const validationError = await validateUrlWithDns(redirectUrl)
    if (validationError) {
      return { error: `Redirect blocked: ${validationError}` }
    }

    // Follow the redirect
    return fetchWithRedirectValidation(redirectUrl, signal, redirectCount + 1)
  }

  return response
}

export function createReadUrlTool() {
  return defineAgentTool({
    name: "read_url",
    description:
      "Fetch and read the full content of a web page. Use this after web_search when you need more detail than the snippet provides, or when the user shares a specific URL to analyze.",
    inputSchema: ReadUrlSchema,

    execute: async (input): Promise<AgentToolResult> => {
      // Validate URL before fetching
      const validationError = await validateUrlWithDns(input.url)
      if (validationError) {
        logger.warn({ url: input.url, reason: validationError }, "URL blocked by SSRF protection")
        return { output: JSON.stringify({ error: validationError, url: input.url }) }
      }

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      try {
        const result = await fetchWithRedirectValidation(input.url, controller.signal)

        if ("error" in result) {
          logger.warn({ url: input.url, error: result.error }, "Fetch failed")
          return { output: JSON.stringify({ error: result.error, url: input.url }) }
        }

        const response = result

        if (!response.ok) {
          logger.warn({ url: input.url, status: response.status }, "Failed to fetch URL")
          return {
            output: JSON.stringify({
              error: `Failed to fetch URL: ${response.status} ${response.statusText}`,
              url: input.url,
            }),
          }
        }

        const contentType = response.headers.get("content-type") || ""
        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
          return {
            output: JSON.stringify({
              error: `Unsupported content type: ${contentType}. Only HTML and plain text are supported.`,
              url: input.url,
            }),
          }
        }

        const html = await response.text()
        const title = extractTitle(html)

        let content: string
        if (contentType.includes("text/plain")) {
          content = html
        } else {
          content = nhm.translate(html)
        }

        if (content.length > MAX_CONTENT_LENGTH) {
          content = content.slice(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated...]"
        }

        const readResult: ReadUrlResult = { url: input.url, title, content }
        logger.debug({ url: input.url, contentLength: content.length }, "URL read completed")

        const output = JSON.stringify(readResult)

        // Extract source if page has a meaningful title
        const sources =
          title && title !== "Untitled" ? [{ title, url: input.url, domain: new URL(input.url).hostname }] : undefined

        return { output, sources }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.warn({ url: input.url }, "URL fetch timed out")
          return {
            output: JSON.stringify({ error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`, url: input.url }),
          }
        }

        logger.error({ error, url: input.url }, "Failed to read URL")
        return {
          output: JSON.stringify({
            error: `Failed to read URL: ${error instanceof Error ? error.message : "Unknown error"}`,
            url: input.url,
          }),
        }
      } finally {
        clearTimeout(timeout)
      }
    },

    trace: {
      stepType: AgentStepTypes.VISIT_PAGE,
      formatContent: (input, result) => {
        try {
          const parsed = JSON.parse(result.output)
          if (parsed.title && parsed.title !== "Untitled") {
            return JSON.stringify({ url: input.url, title: parsed.title })
          }
        } catch {
          /* not valid JSON */
        }
        return JSON.stringify({ url: input.url })
      },
      extractSources: (input, result) => {
        try {
          const parsed = JSON.parse(result.output)
          if (parsed.title && parsed.title !== "Untitled") {
            return [{ type: "web" as const, title: parsed.title, url: input.url, domain: new URL(input.url).hostname }]
          }
        } catch {
          /* not valid JSON */
        }
        return []
      },
    },
  })
}

function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return titleMatch?.[1]?.trim() || "Untitled"
}
