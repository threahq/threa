import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  createGithubPreviewRefreshWorker,
  githubPreviewRefreshQueueId,
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
function fakeLinkPreviewService(row: LinkPreview | null) {
  return {
    getPreviewById: mock(async () => row),
    applyRefreshedMetadata: mock(async () => {}),
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
