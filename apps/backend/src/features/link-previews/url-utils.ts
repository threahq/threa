import type { LinkPreviewContentType } from "@threa/types"

/** Parsed internal message permalink reference */
export interface MessagePermalink {
  workspaceId: string
  streamId: string
  messageId: string
}

export type LinearUrlMatch =
  | {
      type: "linear_issue"
      workspaceSlug: string
      /** Human identifier like `ENG-123`. */
      identifier: string
    }
  | {
      type: "linear_comment"
      workspaceSlug: string
      identifier: string
      /** Linear comment UUID parsed from `#comment-<id>` fragment. */
      commentId: string
    }
  | {
      type: "linear_project"
      workspaceSlug: string
      /** Trailing `{slug}-{shortId}` segment — resolve server-side via `projects(filter: { slugId: { eq } })`. */
      slugId: string
    }
  | {
      type: "linear_document"
      workspaceSlug: string
      slugId: string
    }

export type GitHubUrlMatch =
  | { type: "github_pr"; owner: string; repo: string; number: number }
  | { type: "github_issue"; owner: string; repo: string; number: number }
  | { type: "github_commit"; owner: string; repo: string; sha: string }
  | {
      type: "github_diff"
      owner: string
      repo: string
      number: number
      diffPathHash: string
      anchorSide: "left" | "right" | null
      anchorStartLine: number | null
      anchorEndLine: number | null
    }
  | {
      type: "github_file"
      owner: string
      repo: string
      source: "blob" | "tree" | "repo"
      blobPath: string
      lineStart: number | null
      lineEnd: number | null
    }
  | {
      type: "github_comment"
      owner: string
      repo: string
      commentId: number
      parentType: "pull_request" | "issue"
      number: number
    }

/**
 * Parse an internal message permalink from a URL.
 * Expected format: {origin}/w/{workspaceId}/s/{streamId}?m={messageId}
 * Returns null if the URL doesn't match the expected pattern or the origin isn't recognized.
 */
export function parseMessagePermalink(url: string, appOrigins: string[]): MessagePermalink | null {
  try {
    const parsed = new URL(url)
    const origin = parsed.origin

    if (!appOrigins.some((o) => o === origin)) return null

    // Match /w/:workspaceId/s/:streamId
    const pathMatch = parsed.pathname.match(/^\/w\/([^/]+)\/s\/([^/]+)$/)
    if (!pathMatch) return null

    const messageId = parsed.searchParams.get("m")
    if (!messageId) return null

    return {
      workspaceId: pathMatch[1],
      streamId: pathMatch[2],
      messageId,
    }
  } catch {
    return null
  }
}

/** Tracking parameters to strip during normalization */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "source",
])

/**
 * Private/reserved IP ranges that must not be fetched (SSRF protection).
 * Includes loopback, link-local, private networks, and cloud metadata endpoints.
 */
const BLOCKED_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // private class A
  /^172\.(1[6-9]|2\d|3[01])\./, // private class B
  /^192\.168\./, // private class C
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^\[?::1\]?$/, // IPv6 loopback
  /^\[?fe80:/i, // IPv6 link-local
  /^\[?fc00:/i, // IPv6 unique local
  /^\[?fd/i, // IPv6 unique local
]

/** Hostnames that must not be fetched (cloud metadata endpoints) */
const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata.google.com"])

/**
 * Check if a URL targets a private/internal address (SSRF protection).
 * Returns true if the URL should be blocked.
 */
export function isBlockedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()

    if (BLOCKED_HOSTNAMES.has(hostname)) return true
    if (hostname === "localhost") return true

    // Check IP patterns
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) return true
    }

    return false
  } catch {
    return true // Block unparseable URLs
  }
}

/**
 * Normalize a URL for deduplication.
 * Lowercases host, strips tracking parameters, removes trailing slash.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hostname = url.hostname.toLowerCase()

    // Strip tracking params
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param)
    }

    // Sort remaining params for consistent ordering
    url.searchParams.sort()

    // Remove trailing slash from pathname (but keep root /)
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1)
    }

    // Remove default ports
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = ""
    }

    const githubMatch = parseGitHubUrl(raw)
    const linearMatch = githubMatch ? null : parseLinearUrl(raw)
    if (githubMatch?.type === "github_comment") {
      url.hash = `issuecomment-${githubMatch.commentId}`
    } else if (githubMatch?.type === "github_diff") {
      url.hash = formatGitHubDiffHash(githubMatch)
    } else if (githubMatch?.type === "github_file" && githubMatch.lineStart) {
      url.hash =
        githubMatch.lineEnd && githubMatch.lineEnd !== githubMatch.lineStart
          ? `L${githubMatch.lineStart}-L${githubMatch.lineEnd}`
          : `L${githubMatch.lineStart}`
    } else if (linearMatch?.type === "linear_comment") {
      url.hash = `comment-${linearMatch.commentId}`
    } else {
      url.hash = ""
    }

    return url.toString()
  } catch {
    return raw.toLowerCase()
  }
}

/** URL patterns to skip (internal protocols, data URIs, etc.) */
const SKIP_PATTERNS = [
  /^attachment:/,
  /^data:/,
  /^javascript:/i,
  /^mailto:/,
  /^tel:/,
  /^#/,
  /^\//, // relative paths
]

/**
 * Extract HTTP(S) URLs from markdown content.
 * Returns unique URLs in order of first appearance.
 * Known app origins are allowlisted to bypass SSRF checks (internal message permalinks).
 */
export function extractUrls(markdown: string, appOrigins?: string[]): string[] {
  // Match URLs in markdown links [text](url) and bare URLs.
  // Markdown-link group supports one level of balanced parentheses for Wikipedia-style URLs.
  // Bare URL group allows parens; unbalanced trailing parens are stripped post-match.
  const urlRegex = /(?:\[(?:[^\]]*)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\))|(?:(?:^|\s)(https?:\/\/[^\s<>"]+))/gm
  const seen = new Set<string>()
  const urls: string[] = []
  const originSet = appOrigins ? new Set(appOrigins) : null

  let match
  while ((match = urlRegex.exec(markdown)) !== null) {
    let url = (match[1] ?? match[2])?.trim()
    if (!url) continue

    // For bare URLs (group 2), strip unbalanced trailing parentheses
    if (match[2]) {
      url = stripUnbalancedTrailingParens(url)
    }

    // Skip non-http protocols and internal links
    if (SKIP_PATTERNS.some((p) => p.test(url))) continue

    // Must be a valid URL
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      continue
    }

    // SSRF protection: skip private/internal URLs, unless it's a known app origin
    const isKnownOrigin = originSet?.has(parsed.origin) ?? false
    if (!isKnownOrigin && isBlockedUrl(url)) continue

    const normalized = normalizeUrl(url)
    if (!seen.has(normalized)) {
      seen.add(normalized)
      urls.push(url)
    }
  }

  return urls
}

/**
 * Strip trailing ')' characters that aren't balanced by '(' within the URL.
 * Handles Wikipedia-style URLs like https://en.wikipedia.org/wiki/Foo_(bar)
 * while correctly trimming sentence-ending parens like (see https://example.com)
 */
function stripUnbalancedTrailingParens(url: string): string {
  while (url.endsWith(")")) {
    const opens = (url.match(/\(/g) ?? []).length
    const closes = (url.match(/\)/g) ?? []).length
    if (closes > opens) {
      url = url.slice(0, -1)
    } else {
      break
    }
  }
  return url
}

/** Image file extensions */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "avif"])

/** PDF extension */
const PDF_EXTENSION = "pdf"

/**
 * Detect content type from URL extension.
 * Falls back to "website" if no specific type is detected.
 */
export function detectContentType(url: string): LinkPreviewContentType {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    const ext = pathname.split(".").pop() ?? ""

    if (IMAGE_EXTENSIONS.has(ext)) return "image"
    if (ext === PDF_EXTENSION) return "pdf"
    return "website"
  } catch {
    return "website"
  }
}

export function parseGitHubUrl(raw: string): GitHubUrlMatch | null {
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    if (hostname !== "github.com" && hostname !== "www.github.com") {
      return null
    }

    const repoMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\/?$/)
    if (repoMatch) {
      const [, owner, repo] = repoMatch
      return {
        type: "github_file",
        owner,
        repo,
        source: "repo",
        blobPath: "README.md",
        lineStart: null,
        lineEnd: null,
      }
    }

    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues|commit|blob|tree)\/(.+)$/)
    if (!match) return null

    const [, owner, repo, kind, rest] = match

    if (kind === "pull" || kind === "issues") {
      const number = Number.parseInt(rest.split("/")[0] ?? "", 10)
      if (!Number.isFinite(number)) return null

      const diffAnchor = kind === "pull" ? parsePullDiffHash(url.hash) : null
      if (diffAnchor) {
        const afterNumber = rest.split("/").slice(1)
        const changesView = afterNumber.length === 0 || afterNumber[0] === "files" || afterNumber[0] === "changes"
        if (changesView) {
          return {
            type: "github_diff",
            owner,
            repo,
            number,
            diffPathHash: diffAnchor.diffPathHash,
            anchorSide: diffAnchor.anchorSide,
            anchorStartLine: diffAnchor.anchorStartLine,
            anchorEndLine: diffAnchor.anchorEndLine,
          }
        }
      }

      const commentId = parseIssueCommentId(url.hash)
      if (commentId) {
        return {
          type: "github_comment",
          owner,
          repo,
          commentId,
          parentType: kind === "pull" ? "pull_request" : "issue",
          number,
        }
      }

      return {
        type: kind === "pull" ? "github_pr" : "github_issue",
        owner,
        repo,
        number,
      }
    }

    if (kind === "commit") {
      return {
        type: "github_commit",
        owner,
        repo,
        sha: rest,
      }
    }

    const { lineStart, lineEnd } = parseLineRange(url.hash)
    return {
      type: "github_file",
      owner,
      repo,
      source: kind === "tree" ? "tree" : "blob",
      blobPath: kind === "tree" ? `${rest}/README.md` : rest,
      lineStart,
      lineEnd,
    }
  } catch {
    return null
  }
}

function parseIssueCommentId(hash: string): number | null {
  const match = hash.match(/^#issuecomment-(\d+)$/)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseLineRange(hash: string): { lineStart: number | null; lineEnd: number | null } {
  const match = hash.match(/^#L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/)
  if (!match) {
    return { lineStart: null, lineEnd: null }
  }

  const lineStart = Number.parseInt(match[1], 10)
  const lineEnd = match[2] ? Number.parseInt(match[2], 10) : lineStart
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return { lineStart: null, lineEnd: null }
  }

  return { lineStart, lineEnd }
}

function parsePullDiffHash(hash: string): {
  diffPathHash: string
  anchorSide: "left" | "right" | null
  anchorStartLine: number | null
  anchorEndLine: number | null
} | null {
  const match = hash.match(/^#diff-([a-f0-9]+)(?:([LR])(\d+)(?:-([LR])?(\d+))?)?$/i)
  if (!match) return null

  let anchorSide: "left" | "right" | null = null
  if (match[2] === "L") {
    anchorSide = "left"
  } else if (match[2] === "R") {
    anchorSide = "right"
  }
  const anchorStartLine = match[3] ? Number.parseInt(match[3], 10) : null
  let rangeSide: "left" | "right" | null = null
  if (match[4] === "L") {
    rangeSide = "left"
  } else if (match[4] === "R") {
    rangeSide = "right"
  }
  const anchorEndLine = match[5] ? Number.parseInt(match[5], 10) : anchorStartLine
  if (
    (anchorStartLine !== null && !Number.isFinite(anchorStartLine)) ||
    (anchorEndLine !== null && !Number.isFinite(anchorEndLine))
  ) {
    return null
  }

  return {
    diffPathHash: match[1].toLowerCase(),
    anchorSide: anchorSide ?? rangeSide ?? null,
    anchorStartLine,
    anchorEndLine,
  }
}

function formatGitHubDiffHash(match: Extract<GitHubUrlMatch, { type: "github_diff" }>): string {
  const base = `diff-${match.diffPathHash}`
  if (!match.anchorSide || !match.anchorStartLine) {
    return base
  }

  const sidePrefix = match.anchorSide === "left" ? "L" : "R"
  if (!match.anchorEndLine || match.anchorEndLine === match.anchorStartLine) {
    return `${base}${sidePrefix}${match.anchorStartLine}`
  }

  return `${base}${sidePrefix}${match.anchorStartLine}-${sidePrefix}${match.anchorEndLine}`
}

/** Team/issue identifier like `ENG-123` (uppercase team key, positive integer). */
const LINEAR_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9_]{0,9}-\d+$/
/** Alphanumeric slug id (trailing segment of project/document URLs). */
const LINEAR_SLUG_ID_PATTERN = /^[a-zA-Z0-9_-]+$/
/** Linear comment UUIDs — case-insensitive hex with dashes. */
const LINEAR_COMMENT_ID_PATTERN = /^[a-f0-9-]{8,64}$/i

/**
 * Parse a Linear URL into a preview-ready discriminated union.
 *
 * Supported shapes (hostname-gated to `linear.app`):
 * - `/{workspace}/issue/{TEAM-123}[/slug][#comment-{uuid}]` → `linear_issue` or `linear_comment`
 * - `/{workspace}/project/{slug-id}[/overview|/updates|...]` → `linear_project`
 * - `/{workspace}/document/{slug-id}` → `linear_document`
 */
export function parseLinearUrl(raw: string): LinearUrlMatch | null {
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    if (hostname !== "linear.app" && hostname !== "www.linear.app") {
      return null
    }

    const segments = url.pathname.split("/").filter(Boolean)
    if (segments.length < 3) return null

    const [workspaceSlug, kind, head, ...rest] = segments

    if (kind === "issue") {
      const identifier = head?.toUpperCase()
      if (!identifier || !LINEAR_IDENTIFIER_PATTERN.test(identifier)) return null

      const commentId = parseLinearCommentHash(url.hash)
      if (commentId) {
        return { type: "linear_comment", workspaceSlug, identifier, commentId }
      }
      return { type: "linear_issue", workspaceSlug, identifier }
    }

    if (kind === "project" || kind === "document") {
      // `/project/{slug-id}` or `/project/{slug-id}/overview` both resolve to the same project.
      // `rest` content (overview/updates/etc.) is intentionally discarded.
      void rest
      if (!head || !LINEAR_SLUG_ID_PATTERN.test(head)) return null
      return kind === "project"
        ? { type: "linear_project", workspaceSlug, slugId: head }
        : { type: "linear_document", workspaceSlug, slugId: head }
    }

    return null
  } catch {
    return null
  }
}

function parseLinearCommentHash(hash: string): string | null {
  const match = hash.match(/^#comment-([a-f0-9-]+)$/i)
  if (!match) return null
  const id = match[1]
  return LINEAR_COMMENT_ID_PATTERN.test(id) ? id : null
}
