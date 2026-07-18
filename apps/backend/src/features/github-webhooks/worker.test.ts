import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { createGithubWebhookWorker } from "./worker"
import type { GithubWebhookProcessJobData } from "../../lib/queue/job-queue"
import type { Job } from "../../lib/queue"
import { LinkPreviewService } from "../link-previews"
import { LinkPreviewRepository, type LinkPreview } from "../link-previews/repository"
import * as githubPreview from "../link-previews/github-preview"
import { MessageRepository } from "../messaging"
import { OutboxRepository } from "../../lib/outbox"
import type { WorkspaceIntegrationService } from "../workspace-integrations"

const WORKSPACE_ID = "ws_1"

// A "pool" that satisfies withTransaction's PoolClient branch (has `release`),
// so the service runs its overwrite + outbox writes against this fake directly.
// Every repository call is spied, so the canned query result is never read.
function fakePool(): Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  } as unknown as Pool
}

function makeRow(overrides: Partial<LinkPreview> = {}): LinkPreview {
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
    fetchedAt: null,
    refreshVersion: 0,
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeService(pool: Pool): LinkPreviewService {
  return new LinkPreviewService({
    pool,
    streamService: {} as never,
    memoExplorerService: {} as never,
    delegationService: {} as never,
  })
}

function fakeWorkspaceIntegrationService(workspaceIds: string[]) {
  return {
    listActiveWorkspaceIdsForInstallation: mock(async () => workspaceIds),
    deactivateInstallation: mock(async () => ({ deactivatedWorkspaceIds: workspaceIds })),
  } as unknown as WorkspaceIntegrationService & {
    listActiveWorkspaceIdsForInstallation: ReturnType<typeof mock>
    deactivateInstallation: ReturnType<typeof mock>
  }
}

function fakeJobQueue() {
  return { send: mock(async () => "queue_x") }
}

function prJob(overrides: Partial<GithubWebhookProcessJobData> = {}): Job<GithubWebhookProcessJobData> {
  return {
    id: "q_1",
    name: "github_webhook.process",
    data: {
      workspaceId: "system",
      deliveryGuid: "guid-1",
      eventType: "pull_request",
      action: "synchronize",
      installationId: "42",
      repositoryFullName: "acme/widgets",
      payload: { action: "synchronize", pull_request: { number: 42 } },
      ...overrides,
    },
  }
}

afterEach(() => {
  mock.restore()
})

describe("github webhook worker — refresh flow", () => {
  test("refreshes a matched PR preview and publishes link_preview:ready per linked message", async () => {
    const pool = fakePool()
    const prRow = makeRow()
    const refreshedRow = makeRow({ title: "PR #42: updated title" })

    spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix").mockResolvedValue([prRow])
    spyOn(LinkPreviewRepository, "findById").mockResolvedValue(prRow)
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue({
      status: "completed",
      title: "PR #42: updated title",
      previewType: "github_pr",
    })
    spyOn(LinkPreviewRepository, "overwriteMetadata").mockResolvedValue(refreshedRow)
    spyOn(LinkPreviewRepository, "findMessageIdsByPreviewId").mockResolvedValue(["msg_1"])
    spyOn(MessageRepository, "findStreamIdsByIds").mockResolvedValue(new Map([["msg_1", "stream_1"]]))
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map([["msg_1", [refreshedRow]]]))
    const outboxSpy = spyOn(OutboxRepository, "insertMany").mockResolvedValue(undefined as never)

    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: fakeWorkspaceIntegrationService([WORKSPACE_ID]),
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob())

    // The per-message ready events land as one batched insertMany (INV-56).
    const entries = outboxSpy.mock.calls.flatMap((call) => call[1] as Array<{ eventType: string; payload: unknown }>)
    const readyEntry = entries.find((entry) => entry.eventType === "link_preview:ready")
    expect(readyEntry).toBeDefined()
    const payload = readyEntry!.payload as {
      workspaceId: string
      streamId: string
      messageId: string
      previews: Array<{ id: string; title: string | null }>
    }
    expect(payload).toMatchObject({ workspaceId: WORKSPACE_ID, streamId: "stream_1", messageId: "msg_1" })
    expect(payload.previews).toEqual([expect.objectContaining({ id: "lp_pr", title: "PR #42: updated title" })])
  })

  test("no active workspaces → clean no-op, nothing published", async () => {
    const pool = fakePool()
    const prefixSpy = spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix")
    const outboxSpy = spyOn(OutboxRepository, "insert")

    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: fakeWorkspaceIntegrationService([]),
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob())

    expect(prefixSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  test("no preview rows match → clean no-op", async () => {
    const pool = fakePool()
    spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix").mockResolvedValue([])
    const fetchSpy = spyOn(githubPreview, "fetchGitHubPreview")
    const outboxSpy = spyOn(OutboxRepository, "insert")

    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: fakeWorkspaceIntegrationService([WORKSPACE_ID]),
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob())

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(outboxSpy).not.toHaveBeenCalled()
  })

  test("no installation id → early no-op", async () => {
    const pool = fakePool()
    const wis = fakeWorkspaceIntegrationService([WORKSPACE_ID])
    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: wis,
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob({ installationId: null }))

    expect(wis.listActiveWorkspaceIdsForInstallation).not.toHaveBeenCalled()
  })
})

describe("github webhook worker — installation lifecycle", () => {
  test("installation deleted → deactivates the installation, no refresh", async () => {
    const pool = fakePool()
    const wis = fakeWorkspaceIntegrationService([WORKSPACE_ID])
    const prefixSpy = spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix")

    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: wis,
      jobQueue: fakeJobQueue(),
    })

    await worker(
      prJob({
        eventType: "installation",
        action: "deleted",
        repositoryFullName: null,
        payload: { installation: { id: 42 } },
      })
    )

    expect(wis.deactivateInstallation).toHaveBeenCalledWith("42")
    expect(prefixSpy).not.toHaveBeenCalled()
  })

  test("installation suspend → no-op, does NOT deactivate (routes kept so unsuspend recovers)", async () => {
    const pool = fakePool()
    const wis = fakeWorkspaceIntegrationService([WORKSPACE_ID])
    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: wis,
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob({ eventType: "installation", action: "suspend", repositoryFullName: null, payload: {} }))

    expect(wis.deactivateInstallation).not.toHaveBeenCalled()
  })

  test("installation unsuspend → no-op (v1)", async () => {
    const pool = fakePool()
    const wis = fakeWorkspaceIntegrationService([WORKSPACE_ID])
    const worker = createGithubWebhookWorker({
      pool,
      linkPreviewService: makeService(pool),
      workspaceIntegrationService: wis,
      jobQueue: fakeJobQueue(),
    })

    await worker(prJob({ eventType: "installation", action: "unsuspend", repositoryFullName: null, payload: {} }))

    expect(wis.deactivateInstallation).not.toHaveBeenCalled()
  })
})
