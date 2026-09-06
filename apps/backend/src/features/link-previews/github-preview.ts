import { createHash } from "crypto"
import { logger } from "../../lib/logger"
import type { GitHubPreview, GitHubPreviewRepository, GitHubPreviewType } from "@threahq/types"
import { GitHubPreviewTypes } from "@threahq/types"
import type { UpdateLinkPreviewParams } from "./repository"
import { parseGitHubUrl, type GitHubUrlMatch } from "./url-utils"
import type { WorkspaceIntegrationService } from "../workspace-integrations"

const log = logger.child({ module: "github-link-preview" })

const GITHUB_FAVICON_URL = "https://github.com/favicon.ico"
const DEFAULT_FILE_LINE_COUNT = 30
const COMMENT_PREVIEW_MAX_LENGTH = 320
const README_MARKDOWN_MAX_CHARS = 3000
// Caps (ref, path) split candidates when resolving a blob URL: covers branches up to 4 slashes
// deep (e.g. `feature/team/sprint-42/foo`) while stopping an adversarial URL with many segments
// from burning installation API quota. Bounded by slashes in the branch name, not the file path.
const MAX_BLOB_PATH_SPLIT_ATTEMPTS = 5
const LABEL_COLOR_HEX_PATTERN = /^[0-9a-f]{6}$/i
const DEFAULT_LABEL_COLOR = "999999"

interface LoadedGitHubRepository {
  preview: GitHubPreviewRepository
  defaultBranch: string | null
}

interface PullRequestDiffLine {
  type: "context" | "add" | "delete"
  oldNumber: number | null
  newNumber: number | null
  text: string
}

export async function fetchGitHubPreview(
  workspaceId: string,
  url: string,
  workspaceIntegrationService: WorkspaceIntegrationService
): Promise<UpdateLinkPreviewParams | null> {
  const parsed = parseGitHubUrl(url)
  if (!parsed) return null

  const client = await workspaceIntegrationService.getGithubClient(workspaceId, { repoOwner: parsed.owner })
  if (!client) return null

  try {
    const repository = await loadRepository(client, parsed.owner, parsed.repo)
    if (!repository) return null

    const fetchedAt = new Date().toISOString()

    switch (parsed.type) {
      case "github_pr":
        return fetchPullRequestPreview(client, url, repository.preview, parsed, fetchedAt)
      case "github_issue":
        return fetchIssuePreview(client, url, repository.preview, parsed, fetchedAt)
      case "github_commit":
        return fetchCommitPreview(client, url, repository.preview, parsed, fetchedAt)
      case "github_file":
        return fetchFilePreview(client, url, repository, parsed, fetchedAt)
      case "github_diff":
        return fetchDiffPreview(client, url, repository.preview, parsed, fetchedAt)
      case "github_comment":
        return fetchCommentPreview(client, url, repository.preview, parsed, fetchedAt)
    }
  } catch (error) {
    log.debug({ err: error, workspaceId, url }, "Falling back from GitHub preview to generic preview")
    return null
  }
}

export type GitHubRefreshGateResult =
  | { outcome: "not_modified" }
  | { outcome: "modified"; etag: string | null }
  | { outcome: "unavailable" }

/**
 * Cheap change detector for the conditional (viewport-nudge) refresh path: ONE
 * conditional GET against the preview's primary resource. `not_modified` means
 * the rendered card cannot have changed; `modified` hands back the fresh
 * validator to store alongside the follow-up full fetch. An authorized 304 does
 * not count against the installation's primary rate limit, so a nudge that
 * finds nothing new is free. `unavailable` (no client, unparseable URL, request
 * error) tells the caller to skip quietly — the nudge is best-effort and the
 * next viewport pass retries.
 */
export async function checkGitHubRefreshGate(
  workspaceId: string,
  url: string,
  ifNoneMatch: string | null,
  workspaceIntegrationService: WorkspaceIntegrationService
): Promise<GitHubRefreshGateResult> {
  const parsed = parseGitHubUrl(url)
  if (!parsed) return { outcome: "unavailable" }

  const client = await workspaceIntegrationService.getGithubClient(workspaceId, { repoOwner: parsed.owner })
  if (!client) return { outcome: "unavailable" }

  const gate = gateRequestFor(parsed)
  try {
    const response = await client.requestConditional(gate.route, gate.parameters, ifNoneMatch)
    if (response.status === 304) return { outcome: "not_modified" }
    return { outcome: "modified", etag: response.etag }
  } catch (error) {
    log.debug({ err: error, workspaceId, url }, "GitHub refresh gate errored; skipping conditional refresh")
    return { outcome: "unavailable" }
  }
}

/**
 * The single endpoint whose ETag moves whenever the rendered card could have:
 * PR and diff cards render from the pull object (reviews and new pushes bump
 * its `updated_at`), issue/comment/commit cards from their own resource, and
 * file cards only change after a push, which bumps the repository object's
 * `pushed_at`. Commits are immutable, so their gate correctly answers 304
 * forever.
 */
function gateRequestFor(parsed: GitHubUrlMatch): { route: string; parameters: Record<string, unknown> } {
  const { owner, repo } = parsed
  switch (parsed.type) {
    case "github_pr":
    case "github_diff":
      return {
        route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        parameters: { owner, repo, pull_number: parsed.number },
      }
    case "github_issue":
      return {
        route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
        parameters: { owner, repo, issue_number: parsed.number },
      }
    case "github_commit":
      return { route: "GET /repos/{owner}/{repo}/commits/{ref}", parameters: { owner, repo, ref: parsed.sha } }
    case "github_file":
      return { route: "GET /repos/{owner}/{repo}", parameters: { owner, repo } }
    case "github_comment":
      return {
        route: "GET /repos/{owner}/{repo}/issues/comments/{comment_id}",
        parameters: { owner, repo, comment_id: parsed.commentId },
      }
  }
}

async function fetchPullRequestPreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: GitHubPreviewRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_pr" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const pull = await client.request<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.number,
  })
  const reviews = await client.request<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.number,
    per_page: 100,
  })

  const state = getPullRequestState(pull)
  const reviewStatusSummary = summarizePullReviews(reviews, pull)

  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.PR,
    url,
    repository,
    fetchedAt,
    data: {
      title: pull.title,
      number: pull.number,
      state,
      author: toActor(pull.user),
      baseBranch: pull.base.ref,
      headBranch: pull.head.ref,
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      reviewStatusSummary,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
    },
  }

  return {
    title: `PR #${pull.number}: ${pull.title}`,
    description: `${capitalize(state)} · ${pull.base.ref} ← ${pull.head.ref} · +${pull.additions ?? 0} -${pull.deletions ?? 0}`,
    imageUrl: pull.user?.avatar_url ?? null,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.PR,
    previewData: preview,
    status: "completed",
    expiresAt: state === "open" ? minutesFromNow(5) : hoursFromNow(1),
  }
}

async function fetchDiffPreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: GitHubPreviewRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_diff" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const pull = await client.request<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.number,
  })
  const files = await listPullFiles(client, parsed.owner, parsed.repo, parsed.number)
  const file = files.find((entry) => matchesDiffPathHash(entry, parsed.diffPathHash))
  const pullRequestMatch = {
    type: "github_pr" as const,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
  }

  if (!file || typeof file.patch !== "string") {
    return fetchPullRequestPreview(client, url, repository, pullRequestMatch, fetchedAt)
  }

  const selected = selectDiffPreviewLines(
    parsePullRequestPatch(file.patch),
    parsed.anchorSide,
    parsed.anchorStartLine,
    parsed.anchorEndLine
  )
  if (selected.lines.length === 0) {
    return fetchPullRequestPreview(client, url, repository, pullRequestMatch, fetchedAt)
  }

  const state = getPullRequestState(pull)
  const changeType = normalizePullFileStatus(file.status)
  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.DIFF,
    url,
    repository,
    fetchedAt,
    data: {
      path: file.filename,
      previousPath: typeof file.previous_filename === "string" ? file.previous_filename : null,
      language: detectProgrammingLanguage(file.filename),
      changeType,
      pullRequest: {
        title: pull.title,
        number: pull.number,
        state,
      },
      anchorSide: parsed.anchorSide,
      anchorStartLine: parsed.anchorStartLine,
      anchorEndLine: parsed.anchorEndLine,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      lines: selected.lines,
      truncated: selected.truncated,
    },
  }

  return {
    title: file.filename,
    description: `PR #${pull.number} · ${capitalize(state)} · ${changeType} · +${file.additions ?? 0} -${file.deletions ?? 0}`,
    imageUrl: pull.user?.avatar_url ?? null,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.DIFF,
    previewData: preview,
    status: "completed",
    expiresAt: state === "open" ? minutesFromNow(5) : hoursFromNow(1),
  }
}

async function fetchIssuePreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: GitHubPreviewRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_issue" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const issue = await client.request<any>("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    owner: parsed.owner,
    repo: parsed.repo,
    issue_number: parsed.number,
  })
  if (issue.pull_request) {
    return null
  }

  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.ISSUE,
    url,
    repository,
    fetchedAt,
    data: {
      title: issue.title,
      number: issue.number,
      state: issue.state === "closed" ? "closed" : "open",
      author: toActor(issue.user),
      labels: Array.isArray(issue.labels)
        ? issue.labels.flatMap((label: any) =>
            typeof label?.name === "string"
              ? [
                  {
                    name: label.name,
                    color: normalizeLabelColor(label.color),
                    description: typeof label.description === "string" ? label.description : null,
                  },
                ]
              : []
          )
        : [],
      assignees: Array.isArray(issue.assignees) ? issue.assignees.map(toActor).filter(Boolean) : [],
      commentCount: issue.comments ?? 0,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    },
  }

  return {
    title: `Issue #${issue.number}: ${issue.title}`,
    description: `${capitalize(issue.state)} · ${issue.comments ?? 0} comments`,
    imageUrl: issue.user?.avatar_url ?? null,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.ISSUE,
    previewData: preview,
    status: "completed",
    expiresAt: issue.state === "open" ? minutesFromNow(5) : hoursFromNow(1),
  }
}

async function fetchCommitPreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: GitHubPreviewRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_commit" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const commit = await client.request<any>("GET /repos/{owner}/{repo}/commits/{ref}", {
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.sha,
  })

  const message = String(commit.commit?.message ?? "").split("\n")[0] ?? parsed.sha
  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.COMMIT,
    url,
    repository,
    fetchedAt,
    data: {
      message,
      shortSha: String(commit.sha).slice(0, 7),
      author: toActor(commit.author),
      committedAt: commit.commit?.author?.date ?? null,
      filesChanged: Array.isArray(commit.files) ? commit.files.length : 0,
      additions: commit.stats?.additions ?? 0,
      deletions: commit.stats?.deletions ?? 0,
    },
  }

  return {
    title: message,
    description: `${String(commit.sha).slice(0, 7)} · ${(commit.stats?.total ?? 0) > 0 ? `${commit.stats?.total} changes` : "Commit"}`,
    imageUrl: commit.author?.avatar_url ?? null,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.COMMIT,
    previewData: preview,
    status: "completed",
    expiresAt: hoursFromNow(24),
  }
}

async function fetchFilePreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: LoadedGitHubRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_file" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const resolved = await resolveFileTarget(client, repository, parsed)
  if (!resolved) return null

  const { ref, path, contentResponse } = resolved

  if (
    !contentResponse ||
    Array.isArray(contentResponse) ||
    contentResponse.type !== "file" ||
    typeof contentResponse.content !== "string"
  ) {
    return null
  }

  const decoded = Buffer.from(contentResponse.content.replace(/\n/g, ""), "base64").toString("utf8")
  if (decoded.includes("\u0000")) {
    return null
  }

  const normalized = decoded.replace(/\r\n/g, "\n")
  const allLines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n")
  const startLine = parsed.lineStart ?? 1
  const endLine = Math.min(parsed.lineEnd ?? DEFAULT_FILE_LINE_COUNT, allLines.length)
  const lines = allLines.slice(startLine - 1, endLine).map((text, index) => ({
    number: startLine + index,
    text,
  }))
  const truncated = parsed.lineStart == null ? allLines.length > endLine : false
  const language = detectProgrammingLanguage(resolved.path)
  const renderMode = shouldRenderAsMarkdown(parsed, resolved.path) ? "markdown" : "snippet"
  const markdownContent = renderMode === "markdown" ? buildMarkdownPreview(lines, truncated) : null

  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.FILE,
    url,
    repository: repository.preview,
    fetchedAt,
    data: {
      path: resolved.path,
      language,
      ref: resolved.ref,
      renderMode,
      markdownContent,
      lines,
      startLine,
      endLine,
      truncated,
    },
  }

  return {
    title: resolved.path,
    description: `${resolved.ref}${language ? ` · ${language}` : ""}`,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.FILE,
    previewData: preview,
    status: "completed",
    expiresAt: minutesFromNow(15),
  }
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"])

function shouldRenderAsMarkdown(parsed: Extract<GitHubUrlMatch, { type: "github_file" }>, path: string): boolean {
  if (parsed.source !== "blob") return true
  if (parsed.lineStart != null) return false
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  return MARKDOWN_EXTENSIONS.has(extension)
}

function buildMarkdownPreview(lines: Array<{ number: number; text: string }>, truncated: boolean): string | null {
  const content = lines
    .map((line) => line.text)
    .join("\n")
    .trim()
  if (!content) return null

  if (!truncated || content.length <= README_MARKDOWN_MAX_CHARS) {
    return content
  }

  return `${content.slice(0, README_MARKDOWN_MAX_CHARS).trimEnd()}\n\n...`
}

async function fetchCommentPreview(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  url: string,
  repository: GitHubPreviewRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_comment" }>,
  fetchedAt: string
): Promise<UpdateLinkPreviewParams | null> {
  const comment = await client.request<any>("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
    owner: parsed.owner,
    repo: parsed.repo,
    comment_id: parsed.commentId,
  })

  const parent =
    parsed.parentType === "pull_request"
      ? await client.request<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner: parsed.owner,
          repo: parsed.repo,
          pull_number: parsed.number,
        })
      : await client.request<any>("GET /repos/{owner}/{repo}/issues/{issue_number}", {
          owner: parsed.owner,
          repo: parsed.repo,
          issue_number: parsed.number,
        })

  const body = typeof comment.body === "string" ? comment.body : ""
  const truncated = body.length > COMMENT_PREVIEW_MAX_LENGTH
  const preview: GitHubPreview = {
    type: GitHubPreviewTypes.COMMENT,
    url,
    repository,
    fetchedAt,
    data: {
      body: truncated ? `${body.slice(0, COMMENT_PREVIEW_MAX_LENGTH)}…` : body,
      truncated,
      author: toActor(comment.user),
      createdAt: comment.created_at,
      parent: {
        kind: parsed.parentType,
        title: parent.title,
        number: parent.number,
      },
    },
  }

  return {
    title: `${parsed.parentType === "pull_request" ? "PR" : "Issue"} #${parent.number} comment`,
    description: truncated ? `${body.slice(0, COMMENT_PREVIEW_MAX_LENGTH)}…` : body,
    imageUrl: comment.user?.avatar_url ?? null,
    faviconUrl: GITHUB_FAVICON_URL,
    siteName: "GitHub",
    contentType: "website",
    previewType: GitHubPreviewTypes.COMMENT,
    previewData: preview,
    status: "completed",
    expiresAt: minutesFromNow(15),
  }
}

async function loadRepository(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  owner: string,
  repo: string
): Promise<LoadedGitHubRepository | null> {
  const response = await client.request<any>("GET /repos/{owner}/{repo}", { owner, repo })
  return {
    preview: {
      owner: response.owner?.login ?? owner,
      name: response.name ?? repo,
      fullName: response.full_name ?? `${owner}/${repo}`,
      private: Boolean(response.private),
    },
    defaultBranch: typeof response.default_branch === "string" ? response.default_branch : null,
  }
}

async function listPullFiles(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  owner: string,
  repo: string,
  pullNumber: number
): Promise<any[]> {
  const files: any[] = []
  let page = 1

  for (;;) {
    const response = await client.request<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    })

    files.push(...response)
    if (response.length < 100) break
    page += 1
  }

  return files
}

async function resolveFileTarget(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  repository: LoadedGitHubRepository,
  parsed: Extract<GitHubUrlMatch, { type: "github_file" }>
): Promise<{ ref: string; path: string; contentResponse: any } | null> {
  if (parsed.source === "repo") {
    const readme = await client.request<any>("GET /repos/{owner}/{repo}/readme", {
      owner: parsed.owner,
      repo: parsed.repo,
    })

    if (!readme || typeof readme.content !== "string") {
      return null
    }

    return {
      ref: repository.defaultBranch ?? "default",
      path: typeof readme.path === "string" ? readme.path : "README.md",
      contentResponse: readme,
    }
  }

  return resolveBlobPath(client, parsed.owner, parsed.repo, parsed.blobPath)
}

async function resolveBlobPath(
  client: { request<T>(route: string, parameters?: Record<string, unknown>): Promise<T> },
  owner: string,
  repo: string,
  blobPath: string
): Promise<{ ref: string; path: string; contentResponse: any } | null> {
  const segments = blobPath.split("/").filter(Boolean)
  const maxSplits = Math.min(segments.length - 1, MAX_BLOB_PATH_SPLIT_ATTEMPTS)
  for (let splitIndex = 1; splitIndex <= maxSplits; splitIndex++) {
    const ref = segments.slice(0, splitIndex).join("/")
    const path = segments.slice(splitIndex).join("/")
    try {
      const response = await client.request<any>("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        ref,
      })
      if (response && !Array.isArray(response) && response.type === "file") {
        return { ref, path, contentResponse: response }
      }
    } catch {
      continue
    }
  }

  return null
}

function normalizeLabelColor(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_LABEL_COLOR
  const trimmed = value.startsWith("#") ? value.slice(1) : value
  return LABEL_COLOR_HEX_PATTERN.test(trimmed) ? trimmed.toLowerCase() : DEFAULT_LABEL_COLOR
}

function summarizePullReviews(reviews: any[], pull: any) {
  const latestByUser = new Map<string, string>()
  for (const review of reviews) {
    const login = review.user?.login
    const state = review.state
    if (typeof login !== "string" || typeof state !== "string") continue
    latestByUser.set(login, state)
  }

  let approvals = 0
  let changesRequested = 0
  let comments = 0
  for (const state of latestByUser.values()) {
    if (state === "APPROVED") approvals += 1
    else if (state === "CHANGES_REQUESTED") changesRequested += 1
    else if (state === "COMMENTED") comments += 1
  }

  return {
    approvals,
    changesRequested,
    comments,
    pendingReviewers:
      (Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers.length : 0) +
      (Array.isArray(pull.requested_teams) ? pull.requested_teams.length : 0),
  }
}

function getPullRequestState(pull: any): "open" | "closed" | "merged" {
  if (pull.merged_at) return "merged"
  if (pull.state === "closed") return "closed"
  return "open"
}

function matchesDiffPathHash(file: any, diffPathHash: string): boolean {
  if (typeof file?.filename === "string" && hashGithubDiffPath(file.filename) === diffPathHash) {
    return true
  }

  return typeof file?.previous_filename === "string" && hashGithubDiffPath(file.previous_filename) === diffPathHash
}

function hashGithubDiffPath(path: string): string {
  return createHash("sha256").update(path).digest("hex")
}

function normalizePullFileStatus(status: unknown): "added" | "removed" | "modified" | "renamed" {
  if (status === "added" || status === "removed" || status === "modified" || status === "renamed") {
    return status
  }
  return "modified"
}

function parsePullRequestPatch(patch: string): PullRequestDiffLine[] {
  const lines: PullRequestDiffLine[] = []
  let oldNumber = 0
  let newNumber = 0

  for (const line of patch.split("\n")) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldNumber = Number.parseInt(hunkMatch[1], 10)
      newNumber = Number.parseInt(hunkMatch[2], 10)
      continue
    }

    if (line.startsWith("+")) {
      lines.push({ type: "add", oldNumber: null, newNumber, text: line.slice(1) })
      newNumber += 1
      continue
    }

    if (line.startsWith("-")) {
      lines.push({ type: "delete", oldNumber, newNumber: null, text: line.slice(1) })
      oldNumber += 1
      continue
    }

    if (line.startsWith(" ")) {
      lines.push({ type: "context", oldNumber, newNumber, text: line.slice(1) })
      oldNumber += 1
      newNumber += 1
    }
  }

  return lines
}

function selectDiffPreviewLines(
  lines: PullRequestDiffLine[],
  anchorSide: "left" | "right" | null,
  anchorStartLine: number | null,
  anchorEndLine: number | null
): {
  lines: Array<PullRequestDiffLine & { selected: boolean }>
  truncated: boolean
} {
  if (lines.length === 0) {
    return { lines: [], truncated: false }
  }

  const contextLines = 1
  const defaultPreviewLines = 30
  const maxPreviewLines = 12
  const rangeEnd = anchorEndLine ?? anchorStartLine

  if (anchorSide && anchorStartLine && rangeEnd) {
    const matchingIndexes = lines.flatMap((line, index) => {
      const sideNumber = anchorSide === "left" ? line.oldNumber : line.newNumber
      return sideNumber !== null && sideNumber >= anchorStartLine && sideNumber <= rangeEnd ? [index] : []
    })

    if (matchingIndexes.length > 0) {
      const firstMatch = matchingIndexes[0]
      const lastMatch = matchingIndexes[matchingIndexes.length - 1]
      let start = Math.max(0, firstMatch - contextLines)
      let end = Math.min(lines.length, lastMatch + contextLines + 1)

      if (end - start > maxPreviewLines) {
        start = Math.max(0, firstMatch - contextLines)
        end = Math.min(lines.length, start + maxPreviewLines)
      }

      return {
        lines: lines.slice(start, end).map((line, offset) => {
          const absoluteIndex = start + offset
          return {
            ...line,
            selected: matchingIndexes.includes(absoluteIndex),
          }
        }),
        truncated: start > 0 || end < lines.length,
      }
    }
  }

  const end = Math.min(lines.length, defaultPreviewLines)
  return {
    lines: lines.slice(0, end).map((line) => ({ ...line, selected: false })),
    truncated: end < lines.length,
  }
}

function toActor(user: any) {
  if (!user || typeof user.login !== "string") return null
  return {
    login: user.login,
    avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
  }
}

function detectProgrammingLanguage(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? ""
  switch (extension) {
    case "ts":
      return "TypeScript"
    case "tsx":
      return "TSX"
    case "js":
      return "JavaScript"
    case "jsx":
      return "JSX"
    case "py":
      return "Python"
    case "rb":
      return "Ruby"
    case "go":
      return "Go"
    case "java":
      return "Java"
    case "json":
      return "JSON"
    case "sql":
      return "SQL"
    case "md":
      return "Markdown"
    case "yml":
    case "yaml":
      return "YAML"
    case "sh":
      return "Shell"
    case "css":
      return "CSS"
    case "html":
      return "HTML"
    default:
      return null
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}
