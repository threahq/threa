import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { LinkPreview } from "./repository"
import type { LinkPreviewService } from "./service"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import * as githubPreviewModule from "./github-preview"
import {
  createLinkPreviewVisibleRefreshWorker,
  enqueueVisiblePreviewRefreshes,
  visibleRefreshQueueId,
  VISIBLE_REFRESH_DEBOUNCE_MS,
} from "./visible-refresh"
import type { Job } from "../../lib/queue"
import { JobQueues } from "../../lib/queue"
import type { LinkPreviewVisibleRefreshJobData } from "../../lib/queue/job-queue"

const WORKSPACE_ID = "ws_1"

function makePreview(overrides: Partial<LinkPreview> = {}): LinkPreview {
  return {
    id: "lp_pr",
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
    fetchedAt: new Date(Date.now() - 60_000),
    refreshVersion: 1,
    refreshEtag: null,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeJob(data: LinkPreviewVisibleRefreshJobData): Job<LinkPreviewVisibleRefreshJobData> {
  return { id: "job_1", data } as Job<LinkPreviewVisibleRefreshJobData>
}

function fakeDeps(preview: LinkPreview | null) {
  return {
    linkPreviewService: {
      getPreviewById: mock(async () => preview),
      applyRefreshedMetadata: mock(async () => ({ applied: true })),
      recordRefreshCheck: mock(async () => true),
    } as unknown as LinkPreviewService,
    workspaceIntegrationService: {} as unknown as WorkspaceIntegrationService,
  }
}

afterEach(() => {
  mock.restore()
})

describe("visibleRefreshQueueId", () => {
  test("same debounce-window bucket collapses, next window gets a fresh id", () => {
    // Aligned to a bucket boundary so "+ window - 1" provably stays inside it.
    const t0 = Math.floor(1_000_000_000_000 / VISIBLE_REFRESH_DEBOUNCE_MS) * VISIBLE_REFRESH_DEBOUNCE_MS
    const sameWindow = t0 + VISIBLE_REFRESH_DEBOUNCE_MS - 1
    const nextWindow = t0 + VISIBLE_REFRESH_DEBOUNCE_MS

    expect(visibleRefreshQueueId("lp_a", t0)).toBe(visibleRefreshQueueId("lp_a", sameWindow))
    expect(visibleRefreshQueueId("lp_a", t0)).not.toBe(visibleRefreshQueueId("lp_a", nextWindow))
    expect(visibleRefreshQueueId("lp_a", t0)).not.toBe(visibleRefreshQueueId("lp_b", t0))
  })
})

describe("enqueueVisiblePreviewRefreshes", () => {
  test("sends one bucketed job per preview id", async () => {
    const send = mock(async () => "queued")
    await enqueueVisiblePreviewRefreshes({ send } as never, WORKSPACE_ID, ["lp_a", "lp_b"])

    expect(send).toHaveBeenCalledTimes(2)
    const [queueName, data, options] = send.mock.calls[0] as unknown as [
      string,
      LinkPreviewVisibleRefreshJobData,
      { messageId: string },
    ]
    expect(queueName).toBe(JobQueues.LINK_PREVIEW_VISIBLE_REFRESH)
    expect(data).toEqual({ workspaceId: WORKSPACE_ID, previewId: "lp_a" })
    expect(options.messageId.startsWith("queue_lpviz_lp_a_b")).toBe(true)
  })

  test("a failing send (dedupe collision) is swallowed and other ids still enqueue", async () => {
    const send = mock(async (_q: unknown, data: { previewId: string }) => {
      if (data.previewId === "lp_a") throw new Error("duplicate key")
      return "queued"
    })
    await enqueueVisiblePreviewRefreshes({ send } as never, WORKSPACE_ID, ["lp_a", "lp_b"])

    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe("createLinkPreviewVisibleRefreshWorker", () => {
  test("runs the refresh in conditional mode: a 304 gate answer touches the row and skips the full fetch", async () => {
    const deps = fakeDeps(makePreview({ refreshEtag: '"v1"' }))
    const gateSpy = spyOn(githubPreviewModule, "checkGitHubRefreshGate").mockResolvedValue({
      outcome: "not_modified",
    })
    const fetchSpy = spyOn(githubPreviewModule, "fetchGitHubPreview")

    await createLinkPreviewVisibleRefreshWorker(deps)(makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_pr" }))

    expect(gateSpy).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "https://github.com/acme/widgets/pull/42",
      '"v1"',
      deps.workspaceIntegrationService
    )
    expect(deps.linkPreviewService.recordRefreshCheck).toHaveBeenCalledWith(WORKSPACE_ID, "lp_pr", 1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("uses the visible-refresh debounce, wider than the webhook default", async () => {
    // 12s old: past the webhook path's 10s window but inside this path's 15s
    // window, so a correctly-configured worker must debounce (no gate call).
    const deps = fakeDeps(makePreview({ fetchedAt: new Date(Date.now() - 12_000) }))
    const gateSpy = spyOn(githubPreviewModule, "checkGitHubRefreshGate")

    await createLinkPreviewVisibleRefreshWorker(deps)(makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_pr" }))

    expect(gateSpy).not.toHaveBeenCalled()
  })

  test("drops non-GitHub preview types (opt-in list)", async () => {
    const deps = fakeDeps(makePreview({ previewType: "linear_issue" }))
    const gateSpy = spyOn(githubPreviewModule, "checkGitHubRefreshGate")
    const fetchSpy = spyOn(githubPreviewModule, "fetchGitHubPreview")

    await createLinkPreviewVisibleRefreshWorker(deps)(makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_pr" }))

    expect(gateSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test("drops rows without a provider preview type, pending rows, and vanished rows", async () => {
    const gateSpy = spyOn(githubPreviewModule, "checkGitHubRefreshGate")
    const fetchSpy = spyOn(githubPreviewModule, "fetchGitHubPreview")

    await createLinkPreviewVisibleRefreshWorker(fakeDeps(makePreview({ previewType: null })))(
      makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_pr" })
    )
    await createLinkPreviewVisibleRefreshWorker(fakeDeps(makePreview({ status: "pending" })))(
      makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_pr" })
    )
    await createLinkPreviewVisibleRefreshWorker(fakeDeps(null))(
      makeJob({ workspaceId: WORKSPACE_ID, previewId: "lp_gone" })
    )

    expect(gateSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
