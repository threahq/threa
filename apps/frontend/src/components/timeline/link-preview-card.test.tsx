import { describe, expect, it } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { LinkPreviewCard } from "./link-preview-card"
import type { LinkPreviewSummary } from "@threa/types"

function makeGitHubPreview(overrides: Partial<LinkPreviewSummary> = {}): LinkPreviewSummary {
  return {
    id: "preview_1",
    url: "https://github.com/octocat/hello-world",
    title: null,
    description: null,
    imageUrl: null,
    faviconUrl: "https://github.com/favicon.ico",
    siteName: "GitHub",
    contentType: "website",
    previewType: null,
    previewData: null,
    position: 0,
    ...overrides,
  }
}

describe("LinkPreviewCard", () => {
  it("renders a resilient fallback when generic metadata is empty", () => {
    const preview = makeGitHubPreview({
      url: "https://x.com/someone/status/1234567890",
      title: null,
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: null,
      previewType: null,
      previewData: null,
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText("Open link:")).toBeInTheDocument()
    expect(screen.getByText("x.com/someone/status/1234567890")).toBeInTheDocument()
  })

  it("renders GitHub file preview snippets from structured preview data", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/blob/main/README.md#L1-L2",
      title: "README.md",
      previewType: "github_file",
      previewData: {
        type: "github_file",
        url: "https://github.com/octocat/hello-world/blob/main/README.md#L1-L2",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: true },
        data: {
          path: "README.md",
          language: "Markdown",
          ref: "main",
          renderMode: "snippet",
          markdownContent: null,
          startLine: 1,
          endLine: 2,
          truncated: false,
          lines: [
            { number: 1, text: "# Hello" },
            { number: 2, text: "world" },
          ],
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText("README.md")).toBeInTheDocument()
    expect(screen.getAllByText(/octocat\/hello-world/).length).toBeGreaterThan(0)
    expect(screen.getByText(/L1-L2/)).toBeInTheDocument()
    expect(screen.getAllByText((_, node) => node?.textContent === "# Hello\nworld").length).toBeGreaterThan(0)
  })

  it("renders GitHub tree README previews as markdown content", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/tree/main",
      title: "README.md",
      previewType: "github_file",
      previewData: {
        type: "github_file",
        url: "https://github.com/octocat/hello-world/tree/main",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: true },
        data: {
          path: "README.md",
          language: "Markdown",
          ref: "main",
          renderMode: "markdown",
          markdownContent: "# Hello\n\nworld",
          startLine: 1,
          endLine: 3,
          truncated: false,
          lines: [
            { number: 1, text: "# Hello" },
            { number: 2, text: "" },
            { number: 3, text: "world" },
          ],
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument()
    expect(screen.getByText("world")).toBeInTheDocument()
  })

  it("renders GitHub PR preview with state badge and diff stats", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/pull/42",
      title: "Add feature",
      previewType: "github_pr",
      previewData: {
        type: "github_pr",
        url: "https://github.com/octocat/hello-world/pull/42",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false },
        data: {
          title: "Add feature",
          number: 42,
          state: "open",
          author: { login: "octocat", avatarUrl: null },
          baseBranch: "main",
          headBranch: "feature-branch",
          additions: 120,
          deletions: 30,
          reviewStatusSummary: { approvals: 1, changesRequested: 0, comments: 2, pendingReviewers: 0 },
          createdAt: "2026-04-01T10:00:00.000Z",
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText(/Add feature/)).toBeInTheDocument()
    expect(screen.getByText("#42")).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("+120")).toBeInTheDocument()
    expect(screen.getByText("-30")).toBeInTheDocument()
    expect(screen.getByText("1 approved")).toBeInTheDocument()
    expect(screen.getByText(/octocat\/hello-world/)).toBeInTheDocument()
  })

  it("renders GitHub issue preview with labels", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/issues/7",
      title: "Bug report",
      previewType: "github_issue",
      previewData: {
        type: "github_issue",
        url: "https://github.com/octocat/hello-world/issues/7",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false },
        data: {
          title: "Bug report",
          number: 7,
          state: "open",
          author: { login: "dev", avatarUrl: null },
          labels: [{ name: "bug", color: "d73a4a", description: null }],
          assignees: [],
          commentCount: 3,
          createdAt: "2026-04-01T10:00:00.000Z",
          updatedAt: "2026-04-08T10:00:00.000Z",
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText(/Bug report/)).toBeInTheDocument()
    expect(screen.getByText("#7")).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("bug")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
  })

  it("renders GitHub commit preview with SHA and diff stats", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/commit/abc1234",
      title: "Fix typo in README",
      previewType: "github_commit",
      previewData: {
        type: "github_commit",
        url: "https://github.com/octocat/hello-world/commit/abc1234",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false },
        data: {
          message: "Fix typo in README\n\nCorrected a spelling mistake",
          shortSha: "abc1234",
          author: { login: "octocat", avatarUrl: null },
          committedAt: "2026-04-07T10:00:00.000Z",
          filesChanged: 1,
          additions: 1,
          deletions: 1,
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText("Fix typo in README")).toBeInTheDocument()
    expect(screen.getByText("abc1234")).toBeInTheDocument()
    expect(screen.getByText("1 file")).toBeInTheDocument()
    expect(screen.getByText("+1")).toBeInTheDocument()
    expect(screen.getByText("-1")).toBeInTheDocument()
  })

  it("renders GitHub diff previews with selected diff lines", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/pull/42/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10",
      title: "README.md",
      previewType: "github_diff",
      previewData: {
        type: "github_diff",
        url: "https://github.com/octocat/hello-world/pull/42/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false },
        data: {
          path: "README.md",
          previousPath: null,
          language: "Markdown",
          changeType: "modified",
          pullRequest: {
            title: "Add more context",
            number: 42,
            state: "open",
          },
          anchorSide: "right",
          anchorStartLine: 8,
          anchorEndLine: 10,
          additions: 3,
          deletions: 0,
          truncated: true,
          lines: [
            { type: "context", oldNumber: 1, newNumber: 1, text: "# Hello", selected: false },
            { type: "add", oldNumber: null, newNumber: 8, text: "new line 1", selected: true },
            { type: "add", oldNumber: null, newNumber: 9, text: "new line 2", selected: true },
            { type: "add", oldNumber: null, newNumber: 10, text: "new line 3", selected: true },
          ],
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText("README.md")).toBeInTheDocument()
    expect(screen.getByText(/PR #42/)).toBeInTheDocument()
    expect(screen.getByText(/Modified/)).toBeInTheDocument()
    expect(screen.getByText(/R8-10/)).toBeInTheDocument()
    expect(screen.getByText("new line 2")).toBeInTheDocument()
    expect(screen.getByText("Showing the linked diff hunk only.")).toBeInTheDocument()
  })

  it("renders GitHub comment preview with parent context", () => {
    const preview = makeGitHubPreview({
      url: "https://github.com/octocat/hello-world/issues/7#issuecomment-123",
      title: "Comment on #7",
      previewType: "github_comment",
      previewData: {
        type: "github_comment",
        url: "https://github.com/octocat/hello-world/issues/7#issuecomment-123",
        fetchedAt: "2026-04-08T10:00:00.000Z",
        repository: { owner: "octocat", name: "hello-world", fullName: "octocat/hello-world", private: false },
        data: {
          body: "Looks good to me!",
          truncated: false,
          author: { login: "reviewer", avatarUrl: null },
          createdAt: "2026-04-08T10:00:00.000Z",
          parent: { kind: "issue", title: "Bug report", number: 7 },
        },
      },
    })

    render(<LinkPreviewCard preview={preview} />)

    expect(screen.getByText("reviewer")).toBeInTheDocument()
    expect(screen.getByText(/commented on/)).toBeInTheDocument()
    expect(screen.getByText(/Issue #7/)).toBeInTheDocument()
    expect(screen.getByText("Looks good to me!")).toBeInTheDocument()
  })

  it("renders an image preview inside the shared card chrome", () => {
    const preview = makeGitHubPreview({
      url: "https://example.com/photo.png",
      contentType: "image",
      title: "A nice photo",
      siteName: "Example",
      imageUrl: null,
      previewType: null,
      previewData: null,
    })

    render(<LinkPreviewCard preview={preview} onToggleCollapse={() => {}} />)

    expect(screen.getByText("Example")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Collapse preview/i })).toBeInTheDocument()
    const img = screen.getByAltText("A nice photo") as HTMLImageElement
    expect(img.src).toContain("https://example.com/photo.png")
  })

  function makeVideoPreview(overrides: Partial<LinkPreviewSummary> = {}): LinkPreviewSummary {
    return makeGitHubPreview({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      contentType: "video",
      title: "Never Gonna Give You Up",
      siteName: "YouTube",
      imageUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      previewType: "video",
      previewData: {
        type: "video",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        posterUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        aspectRatio: 16 / 9,
        title: "Never Gonna Give You Up",
        authorName: "Rick Astley",
        fetchedAt: "2026-07-01T00:00:00.000Z",
      },
      ...overrides,
    })
  }

  it("renders a video preview as a click-to-play facade with no iframe mounted", () => {
    render(<LinkPreviewCard preview={makeVideoPreview()} onToggleCollapse={() => {}} />)

    expect(screen.getByText("YouTube")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Play video: Never Gonna Give You Up/i })).toBeInTheDocument()
    // The third-party iframe must not load until the user clicks play.
    expect(screen.queryByTitle("Never Gonna Give You Up")).not.toBeInTheDocument()
  })

  it("mounts the embed iframe with the trusted playback src after clicking play", () => {
    render(<LinkPreviewCard preview={makeVideoPreview()} onToggleCollapse={() => {}} />)

    fireEvent.click(screen.getByRole("button", { name: /Play video/i }))

    const iframe = screen.getByTitle("Never Gonna Give You Up") as HTMLIFrameElement
    expect(iframe.src).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1")
  })

  it("opens the media gallery with the embed when the expand control is clicked", () => {
    render(<LinkPreviewCard preview={makeVideoPreview()} workspaceId="ws_1" onToggleCollapse={() => {}} />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Open video fullscreen/i }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByTitle("Never Gonna Give You Up")).toBeInTheDocument()
  })

  it("opens the media gallery when an image preview is clicked", () => {
    const preview = makeGitHubPreview({
      url: "https://example.com/photo.png",
      contentType: "image",
      title: "A nice photo",
      siteName: "Example",
      imageUrl: null,
      previewType: null,
      previewData: null,
    })

    render(<LinkPreviewCard preview={preview} workspaceId="ws_1" onToggleCollapse={() => {}} />)

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Open image preview/i }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("A nice photo").length).toBeGreaterThan(0)
  })
})
