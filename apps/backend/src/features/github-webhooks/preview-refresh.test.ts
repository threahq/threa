import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  createGithubPreviewRefreshWorker,
  githubPreviewRefreshQueueId,
  githubPreviewRefreshRetryQueueId,
  refreshGithubPreviewWithTrailing,
} from "./preview-refresh"
import type { LinkPreview } from "../link-previews/repository"
import type { LinkPreviewService } from "../link-previews"
import * as githubPreview from "../link-previews/github-preview"

const WORKSPACE_ID = "ws_1"
const PREVIEW_ID = "lp_pr"

function makeRow(overrides: Partial<LinkPreview> = {}): LinkPreview {
  return {
    id: PREVIEW_ID,
    workspaceId: WORKSPACE_ID,
    url: "https://github.com/acme/widgets/pull/42",
    normalizedUrl: "https://github.com/acme/widgets/pull/42",
    title: "PR #42",
    description: null,
    imageUrl: null,
    faviconUrl: null,
    siteName: "GitHub",
    contentType: "website",
    status: "completed",
    previewType: "github_pr",
    previewData: null,
    targetWorkspaceId: null,
    targetStreamId: null,
    targetMessageId: null,
    targetMemoId: null,
    targetConversationId: null,
    targetDelegationId: null,
    fetchedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

/** Fake service exposing only what `refreshLinkPreview` touches. */
function fakeLinkPreviewService(
  row: LinkPreview | null,
  applyResult: { applied: true } | { applied: false; fetchedAt: Date | null } = { applied: true }
) {
  return {
    getPreviewById: mock(async () => row),
    applyRefreshedMetadata: mock(async () => applyResult),
  } as unknown as LinkPreviewService & {
    getPreviewById: ReturnType<typeof mock>
    applyRefreshedMetadata: ReturnType<typeof mock>
  }
}

function fakeJobQueue() {
  return {
    send: mock(
      async (_queueName: string, _data: unknown, _options?: { processAfter?: Date; messageId?: string }) => "queue_x"
    ),
  }
}

afterEach(() => {
  mock.restore()
})

describe("refreshGithubPreviewWithTrailing — debounce coalescing", () => {
  test("a debounced refresh schedules exactly one trailing job keyed on (previewId, fetchedAt)", async () => {
    const fetchedAt = new Date(Date.now() - 2_000) // 2s ago → inside the 10s window
    const service = fakeLinkPreviewService(makeRow({ fetchedAt }))
    const jobQueue = fakeJobQueue()
    const fetchSpy = spyOn(githubPreview, "fetchGitHubPreview")

    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
    )

    // Debounced: never re-fetched or overwrote the row, and a trailing job is queued.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(service.applyRefreshedMetadata).not.toHaveBeenCalled()
    expect(jobQueue.send).toHaveBeenCalledTimes(1)

    const [queueName, data, options] = jobQueue.send.mock.calls[0]!
    expect(queueName).toBe("github_preview.refresh")
    expect(data).toEqual({ workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID })
    expect(options!.messageId).toBe(githubPreviewRefreshQueueId(PREVIEW_ID, fetchedAt))
    // processAfter is past the remaining debounce window.
    expect(options!.processAfter!.getTime()).toBeGreaterThan(fetchedAt.getTime() + 10_000)
  })

  test("a storm of N debounced deliveries collapses to a single dedupe id", async () => {
    const fetchedAt = new Date(Date.now() - 1_000)
    const service = fakeLinkPreviewService(makeRow({ fetchedAt }))
    const jobQueue = fakeJobQueue()
    spyOn(githubPreview, "fetchGitHubPreview")

    for (let i = 0; i < 5; i++) {
      await refreshGithubPreviewWithTrailing(
        { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
        { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
      )
    }

    const messageIds = new Set(jobQueue.send.mock.calls.map((call) => call[2]!.messageId))
    expect(messageIds).toEqual(new Set([githubPreviewRefreshQueueId(PREVIEW_ID, fetchedAt)]))
  })

  test("trailing worker that lands after the window refreshes the row, no reschedule", async () => {
    const fetchedAt = new Date(Date.now() - 30_000) // long past the window
    const service = fakeLinkPreviewService(makeRow({ fetchedAt }))
    const jobQueue = fakeJobQueue()
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue({
      status: "completed",
      title: "PR #42: updated",
      previewType: "github_pr",
    })

    const worker = createGithubPreviewRefreshWorker({
      linkPreviewService: service,
      workspaceIntegrationService: {} as never,
      jobQueue,
    })

    await worker({
      id: "q_1",
      name: "github_preview.refresh",
      data: { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID },
    })

    expect(service.applyRefreshedMetadata).toHaveBeenCalledTimes(1)
    expect(jobQueue.send).not.toHaveBeenCalled()
  })

  test("trailing worker still inside the window reschedules once on the fresh fetchedAt", async () => {
    const fetchedAt = new Date(Date.now() - 3_000)
    const service = fakeLinkPreviewService(makeRow({ fetchedAt }))
    const jobQueue = fakeJobQueue()
    spyOn(githubPreview, "fetchGitHubPreview")

    const worker = createGithubPreviewRefreshWorker({
      linkPreviewService: service,
      workspaceIntegrationService: {} as never,
      jobQueue,
    })

    await worker({
      id: "q_1",
      name: "github_preview.refresh",
      data: { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID },
    })

    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    expect(jobQueue.send.mock.calls[0]![2]!.messageId).toBe(githubPreviewRefreshQueueId(PREVIEW_ID, fetchedAt))
  })
})

describe("refreshGithubPreviewWithTrailing — compare-and-set conflict", () => {
  test("a CAS loss does not overwrite and schedules one trailing refresh keyed on the winner's fetchedAt", async () => {
    const winnerFetchedAt = new Date()
    const service = fakeLinkPreviewService(makeRow({ fetchedAt: new Date(Date.now() - 30_000) }), {
      applied: false,
      fetchedAt: winnerFetchedAt,
    })
    const jobQueue = fakeJobQueue()
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue({
      status: "completed",
      title: "PR #42: updated",
      previewType: "github_pr",
    })

    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
    )

    // The refresh was attempted (fetched + applyRefreshedMetadata called) but the
    // CAS reported not-applied, so exactly one trailing refresh is queued.
    expect(service.applyRefreshedMetadata).toHaveBeenCalledTimes(1)
    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    const [queueName, data, options] = jobQueue.send.mock.calls[0]!
    expect(queueName).toBe("github_preview.refresh")
    expect(data).toEqual({ workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID })
    expect(options!.messageId).toBe(githubPreviewRefreshQueueId(PREVIEW_ID, winnerFetchedAt))
  })
})

describe("refreshGithubPreviewWithTrailing — transient fetch failure retries", () => {
  const OUTAGE_FETCHED_AT = new Date(Date.now() - 60_000)

  function makeFetchEmptyDeps(fetchedAt: Date | null = OUTAGE_FETCHED_AT) {
    // fetched_at long past the window so the refresh proceeds to a fetch, which
    // returns null (GitHub 5xx / rate-limit breaker) → reason 'fetch_empty'.
    const service = fakeLinkPreviewService(makeRow({ fetchedAt }))
    const jobQueue = fakeJobQueue()
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue(null)
    return { service, jobQueue }
  }

  test("first empty fetch schedules a retry at attempt 1", async () => {
    const { service, jobQueue } = makeFetchEmptyDeps()

    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
    )

    expect(jobQueue.send).toHaveBeenCalledTimes(1)
    const [queueName, data, options] = jobQueue.send.mock.calls[0]!
    expect(queueName).toBe("github_preview.refresh")
    expect(data).toEqual({ workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID, attempt: 1 })
    expect(options!.messageId).toBe(githubPreviewRefreshRetryQueueId(PREVIEW_ID, OUTAGE_FETCHED_AT, 1))
    // ~30s backoff.
    expect(options!.processAfter!.getTime()).toBeGreaterThan(Date.now() + 20_000)
  })

  test("each retry increments attempt and keys on a distinct id", async () => {
    const { service, jobQueue } = makeFetchEmptyDeps()

    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID, attempt: 1 }
    )

    const [, data, options] = jobQueue.send.mock.calls[0]!
    expect(data).toEqual({ workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID, attempt: 2 })
    expect(options!.messageId).toBe(githubPreviewRefreshRetryQueueId(PREVIEW_ID, OUTAGE_FETCHED_AT, 2))
  })

  test("two outage cycles at different fetched_at values produce distinct retry ids", async () => {
    const earlier = new Date(Date.now() - 3_600_000)
    const later = new Date(Date.now() - 60_000)

    const first = makeFetchEmptyDeps(earlier)
    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: first.service, workspaceIntegrationService: {} as never, jobQueue: first.jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
    )
    const firstId = first.jobQueue.send.mock.calls[0]![2]!.messageId

    const second = makeFetchEmptyDeps(later)
    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: second.service, workspaceIntegrationService: {} as never, jobQueue: second.jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID }
    )
    const secondId = second.jobQueue.send.mock.calls[0]![2]!.messageId

    // Same previewId + same attempt (1) but a fetched_at advanced by a prior
    // successful refresh — the ids must differ so the second cycle's retry is not
    // dropped by a pkey collision with the never-purged completed first-cycle row.
    expect(firstId).not.toBe(secondId)
    expect(firstId).toBe(githubPreviewRefreshRetryQueueId(PREVIEW_ID, earlier, 1))
    expect(secondId).toBe(githubPreviewRefreshRetryQueueId(PREVIEW_ID, later, 1))
  })

  test("stops retrying after the third attempt, no further job", async () => {
    const { service, jobQueue } = makeFetchEmptyDeps()

    await refreshGithubPreviewWithTrailing(
      { linkPreviewService: service, workspaceIntegrationService: {} as never, jobQueue },
      { workspaceId: WORKSPACE_ID, previewId: PREVIEW_ID, attempt: 3 }
    )

    expect(jobQueue.send).not.toHaveBeenCalled()
  })
})
