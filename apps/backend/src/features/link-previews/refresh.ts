import type { Pool } from "pg"
import { logger } from "@threa/backend-common"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import { LinkPreviewRepository, type LinkPreview } from "./repository"
import type { LinkPreviewService } from "./service"
import * as githubPreview from "./github-preview"
import { parseGitHubUrl, type GitHubUrlMatch } from "./url-utils"

const log = logger.child({ module: "link-preview-refresh" })

/** Skip a refresh whose row was fetched this recently (webhook storms). */
export const DEFAULT_REFRESH_DEBOUNCE_MS = 10_000

export interface RefreshLinkPreviewDeps {
  linkPreviewService: LinkPreviewService
  workspaceIntegrationService: WorkspaceIntegrationService
}

export type RefreshLinkPreviewResult =
  | { refreshed: true }
  | { refreshed: false; reason: "not_found" }
  /**
   * The fetch came back empty (GitHub 5xx / timeout / rate-limit breaker), so
   * `fetched_at` did NOT advance. `fetchedAt` is that unchanged row value — a
   * caller keys a bounded retry on it so distinct outage cycles (which each key on
   * the `fetched_at` a prior successful refresh advanced to) get distinct ids and
   * don't collide with a persisted completed retry row.
   */
  | { refreshed: false; reason: "fetch_empty"; fetchedAt: Date | null }
  /**
   * The row was fetched inside `debounceMs`, so this refresh was dropped.
   * `retryAfterMs` is the time until the window clears; `fetchedAt` is the row's
   * current fetch timestamp — a caller coalescing a webhook storm keys a single
   * trailing refresh on it (all storm events share the same `fetchedAt` until a
   * refresh actually lands, so they collapse to one job).
   */
  | { refreshed: false; reason: "debounced"; retryAfterMs: number; fetchedAt: Date }
  /**
   * Compare-and-set loss: between reading `fetched_at` and writing, a concurrent
   * refresh advanced the row, so this (possibly stale) fetch was NOT written.
   * `fetchedAt` is the winner's current value — the caller re-keys a single
   * trailing refresh on it so the row converges on a fresh fetch.
   */
  | { refreshed: false; reason: "conflict"; fetchedAt: Date | null }

/**
 * Force-refresh one already-rendered GitHub link preview from an external
 * invalidation signal (a webhook), not from message content. Re-fetches the row
 * through `fetchGitHubPreview` (network, outside any transaction — INV-41), then
 * hands the metadata to the service to overwrite + broadcast (INV-6). Naturally
 * idempotent: re-running overwrites the same row and re-broadcasts, so at-least-
 * once webhook delivery needs no dedupe table.
 *
 * Skips (never downgrades) when: the row is gone, it was fetched within
 * `debounceMs`, or the fetch comes back empty (rate-limited/null client) — an
 * empty fetch must not blank a rich card.
 */
export async function refreshLinkPreview(
  deps: RefreshLinkPreviewDeps,
  params: { workspaceId: string; previewId: string; debounceMs?: number; useOptimisticConcurrency?: boolean }
): Promise<RefreshLinkPreviewResult> {
  const debounceMs = params.debounceMs ?? DEFAULT_REFRESH_DEBOUNCE_MS
  const preview = await deps.linkPreviewService.getPreviewById(params.workspaceId, params.previewId)
  if (!preview) return { refreshed: false, reason: "not_found" }

  // Captured BEFORE the network fetch so the write can compare-and-set against it:
  // a slower concurrent refresh that started earlier must not overwrite a newer
  // write completed while this one was in flight (webhook path only).
  const expectedFetchedAt = preview.fetchedAt

  if (preview.fetchedAt) {
    const elapsedMs = Date.now() - preview.fetchedAt.getTime()
    if (elapsedMs < debounceMs) {
      log.debug(
        { workspaceId: params.workspaceId, previewId: params.previewId },
        "Skipping preview refresh — debounced"
      )
      return {
        refreshed: false,
        reason: "debounced",
        retryAfterMs: debounceMs - elapsedMs,
        fetchedAt: preview.fetchedAt,
      }
    }
  }

  const metadata = await githubPreview.fetchGitHubPreview(
    params.workspaceId,
    preview.url,
    deps.workspaceIntegrationService
  )
  if (!metadata) {
    log.debug(
      { workspaceId: params.workspaceId, previewId: params.previewId },
      "Skipping preview refresh — GitHub fetch returned no metadata"
    )
    return { refreshed: false, reason: "fetch_empty", fetchedAt: expectedFetchedAt }
  }

  if (params.useOptimisticConcurrency) {
    const outcome = await deps.linkPreviewService.applyRefreshedMetadata(
      params.workspaceId,
      params.previewId,
      metadata,
      { expectedFetchedAt }
    )
    if (!outcome.applied) {
      log.debug(
        { workspaceId: params.workspaceId, previewId: params.previewId },
        "Skipping preview refresh — compare-and-set lost to a concurrent refresh"
      )
      return { refreshed: false, reason: "conflict", fetchedAt: outcome.fetchedAt }
    }
    return { refreshed: true }
  }

  await deps.linkPreviewService.applyRefreshedMetadata(params.workspaceId, params.previewId, metadata)
  return { refreshed: true }
}

/**
 * Backslash-escape LIKE wildcards so a value used as a prefix matches literally.
 * Repo names legitimately contain `_` (a single-char wildcard); without this a
 * base like `.../my_repo/pull/1` would over-match.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Family+repo+number identity shared by a PR/issue and its diff/comment anchor
 * variants. A `pull_request` refresh must reach the plain PR card, its diff cards
 * (`/pull/n/files#diff-…`), and its PR-comment cards (`#issuecomment-…`); an
 * `issues` refresh reaches the issue card and its issue-comment cards. Owner/repo
 * are lowercased (GitHub treats them case-insensitively). Returns null for URL
 * shapes that carry no PR/issue number (commits, files).
 */
export function githubTargetIdentity(match: GitHubUrlMatch): string | null {
  switch (match.type) {
    case "github_pr":
    case "github_diff":
      return `pull:${match.owner.toLowerCase()}/${match.repo.toLowerCase()}:${match.number}`
    case "github_issue":
      return `issues:${match.owner.toLowerCase()}/${match.repo.toLowerCase()}:${match.number}`
    case "github_comment": {
      const family = match.parentType === "pull_request" ? "pull" : "issues"
      return `${family}:${match.owner.toLowerCase()}/${match.repo.toLowerCase()}:${match.number}`
    }
    default:
      return null
  }
}

/**
 * Completed GitHub preview rows in a workspace that a webhook target invalidates.
 * `normalizedBaseUrls` are canonical PR/issue URLs (already run through
 * `normalizeUrl`). Narrows in the DB by normalized-URL prefix, then confirms each
 * row by parsing its URL and comparing the family+repo+number identity so the
 * prefix's coarseness (`/pull/12` vs `/pull/123`) can't produce a false match.
 */
export async function findGithubPreviewMatches(
  pool: Pool,
  workspaceId: string,
  normalizedBaseUrls: string[]
): Promise<LinkPreview[]> {
  const identities = new Set<string>()
  for (const base of normalizedBaseUrls) {
    const parsed = parseGitHubUrl(base)
    const identity = parsed ? githubTargetIdentity(parsed) : null
    if (identity) identities.add(identity)
  }
  if (identities.size === 0) return []

  const seen = new Map<string, LinkPreview>()
  for (const base of normalizedBaseUrls) {
    const rows = await LinkPreviewRepository.findByNormalizedUrlPrefix(pool, workspaceId, escapeLikePattern(base))
    for (const row of rows) {
      if (seen.has(row.id)) continue
      const parsed = parseGitHubUrl(row.url)
      const identity = parsed ? githubTargetIdentity(parsed) : null
      if (identity && identities.has(identity)) seen.set(row.id, row)
    }
  }
  return [...seen.values()]
}
