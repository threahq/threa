import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { Pool } from "pg"
import { escapeLikePattern, findGithubPreviewMatches, githubTargetIdentity, refreshLinkPreview } from "./refresh"
import { LinkPreviewRepository, type LinkPreview } from "./repository"
import * as githubPreview from "./github-preview"
import { parseGitHubUrl } from "./url-utils"
import type { LinkPreviewService } from "./service"
import type { WorkspaceIntegrationService } from "../workspace-integrations"
import type { UpdateLinkPreviewParams } from "./repository"

const WORKSPACE_ID = "ws_1"
const fakePool = {} as unknown as Pool

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
    expiresAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

const REFRESHED_METADATA: UpdateLinkPreviewParams = { status: "completed", title: "PR #42: updated" }

afterEach(() => {
  mock.restore()
})

describe("escapeLikePattern", () => {
  test("escapes LIKE wildcards so a repo underscore matches literally", () => {
    expect(escapeLikePattern("https://github.com/a/my_repo/pull/1")).toBe("https://github.com/a/my\\_repo/pull/1")
    expect(escapeLikePattern("100%_x")).toBe("100\\%\\_x")
  })
})

describe("githubTargetIdentity", () => {
  test("PR, its diff, and its PR-comment share one identity", () => {
    const pr = parseGitHubUrl("https://github.com/acme/widgets/pull/42")!
    const diff = parseGitHubUrl("https://github.com/acme/widgets/pull/42/files#diff-abc123")!
    const comment = parseGitHubUrl("https://github.com/acme/widgets/pull/42#issuecomment-99")!
    expect(githubTargetIdentity(pr)).toBe("pull:acme/widgets:42")
    expect(githubTargetIdentity(diff)).toBe("pull:acme/widgets:42")
    expect(githubTargetIdentity(comment)).toBe("pull:acme/widgets:42")
  })

  test("issue and its issue-comment share one identity, distinct from PRs", () => {
    const issue = parseGitHubUrl("https://github.com/acme/widgets/issues/7")!
    const comment = parseGitHubUrl("https://github.com/acme/widgets/issues/7#issuecomment-5")!
    expect(githubTargetIdentity(issue)).toBe("issues:acme/widgets:7")
    expect(githubTargetIdentity(comment)).toBe("issues:acme/widgets:7")
  })

  test("owner/repo compared case-insensitively", () => {
    const upper = parseGitHubUrl("https://github.com/Acme/Widgets/pull/42")!
    expect(githubTargetIdentity(upper)).toBe("pull:acme/widgets:42")
  })
})

describe("findGithubPreviewMatches", () => {
  test("matches the PR row, its diff row, and its comment row", async () => {
    const prRow = makeRow({ id: "lp_pr" })
    const diffRow = makeRow({
      id: "lp_diff",
      url: "https://github.com/acme/widgets/pull/42/files#diff-abc123",
      normalizedUrl: "https://github.com/acme/widgets/pull/42/files#diff-abc123",
      previewType: "github_diff",
    })
    const commentRow = makeRow({
      id: "lp_comment",
      url: "https://github.com/acme/widgets/pull/42#issuecomment-99",
      normalizedUrl: "https://github.com/acme/widgets/pull/42#issuecomment-99",
      previewType: "github_comment",
    })
    const spy = spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix").mockResolvedValue([
      prRow,
      diffRow,
      commentRow,
    ])

    const matches = await findGithubPreviewMatches(fakePool, WORKSPACE_ID, ["https://github.com/acme/widgets/pull/42"])

    expect(matches.map((m) => m.id).sort()).toEqual(["lp_comment", "lp_diff", "lp_pr"])
    // Prefix escaping applied at the DB boundary.
    expect(spy).toHaveBeenCalledWith(fakePool, WORKSPACE_ID, "https://github.com/acme/widgets/pull/42")
  })

  test("excludes a different PR number that shares the coarse prefix", async () => {
    const otherPr = makeRow({
      id: "lp_other",
      url: "https://github.com/acme/widgets/pull/420",
      normalizedUrl: "https://github.com/acme/widgets/pull/420",
    })
    spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix").mockResolvedValue([otherPr])

    const matches = await findGithubPreviewMatches(fakePool, WORKSPACE_ID, ["https://github.com/acme/widgets/pull/42"])

    expect(matches).toEqual([])
  })

  test("excludes a same-number PR in a different repo", async () => {
    const otherRepo = makeRow({
      id: "lp_repo",
      url: "https://github.com/acme/gadgets/pull/42",
      normalizedUrl: "https://github.com/acme/gadgets/pull/42",
    })
    spyOn(LinkPreviewRepository, "findByNormalizedUrlPrefix").mockResolvedValue([otherRepo])

    const matches = await findGithubPreviewMatches(fakePool, WORKSPACE_ID, ["https://github.com/acme/widgets/pull/42"])

    expect(matches).toEqual([])
  })
})

describe("refreshLinkPreview", () => {
  function fakeService(preview: LinkPreview | null) {
    return {
      getPreviewById: mock(async () => preview),
      applyRefreshedMetadata: mock(async () => {}),
    } as unknown as LinkPreviewService & {
      getPreviewById: ReturnType<typeof mock>
      applyRefreshedMetadata: ReturnType<typeof mock>
    }
  }

  const wis = {} as unknown as WorkspaceIntegrationService

  test("skips when the row no longer exists", async () => {
    const service = fakeService(null)
    const result = await refreshLinkPreview(
      { linkPreviewService: service, workspaceIntegrationService: wis },
      { workspaceId: WORKSPACE_ID, previewId: "lp_pr" }
    )
    expect(result).toEqual({ refreshed: false, reason: "not_found" })
    expect(service.applyRefreshedMetadata).not.toHaveBeenCalled()
  })

  test("debounces a row fetched within the window", async () => {
    const service = fakeService(makeRow({ fetchedAt: new Date(Date.now() - 2_000) }))
    const fetchSpy = spyOn(githubPreview, "fetchGitHubPreview")

    const result = await refreshLinkPreview(
      { linkPreviewService: service, workspaceIntegrationService: wis },
      { workspaceId: WORKSPACE_ID, previewId: "lp_pr", debounceMs: 10_000 }
    )

    expect(result).toEqual({ refreshed: false, reason: "debounced" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(service.applyRefreshedMetadata).not.toHaveBeenCalled()
  })

  test("refreshes a row fetched before the debounce window", async () => {
    const service = fakeService(makeRow({ fetchedAt: new Date(Date.now() - 60_000) }))
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue(REFRESHED_METADATA)

    const result = await refreshLinkPreview(
      { linkPreviewService: service, workspaceIntegrationService: wis },
      { workspaceId: WORKSPACE_ID, previewId: "lp_pr", debounceMs: 10_000 }
    )

    expect(result).toEqual({ refreshed: true })
    expect(service.applyRefreshedMetadata).toHaveBeenCalledWith(WORKSPACE_ID, "lp_pr", REFRESHED_METADATA)
  })

  test("does not downgrade when the GitHub fetch returns nothing", async () => {
    const service = fakeService(makeRow())
    spyOn(githubPreview, "fetchGitHubPreview").mockResolvedValue(null)

    const result = await refreshLinkPreview(
      { linkPreviewService: service, workspaceIntegrationService: wis },
      { workspaceId: WORKSPACE_ID, previewId: "lp_pr" }
    )

    expect(result).toEqual({ refreshed: false, reason: "fetch_empty" })
    expect(service.applyRefreshedMetadata).not.toHaveBeenCalled()
  })
})
