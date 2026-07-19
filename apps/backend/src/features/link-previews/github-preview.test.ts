import { describe, expect, test } from "bun:test"
import { checkGitHubRefreshGate, fetchGitHubPreview } from "./github-preview"
import type { WorkspaceIntegrationService } from "../workspace-integrations"

describe("fetchGitHubPreview", () => {
  test("builds a rich pull request preview", async () => {
    const preview = await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world/pull/42", {
      async getGithubClient() {
        return {
          async request(route: string) {
            switch (route) {
              case "GET /repos/{owner}/{repo}":
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: true,
                }
              case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
                return {
                  number: 42,
                  title: "Ship the thing",
                  state: "open",
                  merged_at: null,
                  user: { login: "kris", avatar_url: "https://avatars.example/kris.png" },
                  base: { ref: "main" },
                  head: { ref: "feature/github-preview" },
                  additions: 12,
                  deletions: 4,
                  requested_reviewers: [{ login: "reviewer-a" }],
                  requested_teams: [],
                  created_at: "2026-04-07T10:00:00.000Z",
                  updated_at: "2026-04-07T11:00:00.000Z",
                }
              case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
                return [
                  { user: { login: "alice" }, state: "COMMENTED" },
                  { user: { login: "alice" }, state: "APPROVED" },
                  { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
                ]
              default:
                throw new Error(`Unexpected route: ${route}`)
            }
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).not.toBeNull()
    expect(preview).toMatchObject({
      previewType: "github_pr",
      previewData: {
        repository: {
          owner: "octocat",
          name: "hello-world",
          fullName: "octocat/hello-world",
          private: true,
        },
        data: {
          title: "Ship the thing",
          number: 42,
          state: "open",
          baseBranch: "main",
          headBranch: "feature/github-preview",
          additions: 12,
          deletions: 4,
          reviewStatusSummary: {
            approvals: 1,
            changesRequested: 1,
            comments: 0,
            pendingReviewers: 1,
          },
        },
      },
      status: "completed",
      siteName: "GitHub",
    })
  })

  test("builds a diff preview for pull request changes anchors", async () => {
    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/pull/42/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R8-R10",
      {
        async getGithubClient() {
          return {
            async request(route: string) {
              switch (route) {
                case "GET /repos/{owner}/{repo}":
                  return {
                    owner: { login: "octocat" },
                    name: "hello-world",
                    full_name: "octocat/hello-world",
                    private: true,
                  }
                case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
                  return {
                    number: 42,
                    title: "Ship the thing",
                    state: "open",
                    merged_at: null,
                    user: { login: "kris", avatar_url: "https://avatars.example/kris.png" },
                    base: { ref: "main" },
                    head: { ref: "feature/github-preview" },
                    additions: 12,
                    deletions: 4,
                    created_at: "2026-04-07T10:00:00.000Z",
                    updated_at: "2026-04-07T11:00:00.000Z",
                  }
                case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
                  return [
                    {
                      filename: "README.md",
                      status: "modified",
                      additions: 3,
                      deletions: 0,
                      patch: "@@ -7,1 +7,4 @@\n existing line\n+new line 1\n+new line 2\n+new line 3",
                    },
                  ]
                default:
                  throw new Error(`Unexpected route: ${route}`)
              }
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toMatchObject({
      previewType: "github_diff",
      title: "README.md",
      previewData: {
        type: "github_diff",
        data: {
          path: "README.md",
          changeType: "modified",
          anchorSide: "right",
          anchorStartLine: 8,
          anchorEndLine: 10,
          additions: 3,
          deletions: 0,
          lines: [
            { type: "context", oldNumber: 7, newNumber: 7, text: "existing line", selected: false },
            { type: "add", oldNumber: null, newNumber: 8, text: "new line 1", selected: true },
            { type: "add", oldNumber: null, newNumber: 9, text: "new line 2", selected: true },
            { type: "add", oldNumber: null, newNumber: 10, text: "new line 3", selected: true },
          ],
        },
      },
    })
  })

  test("builds a full short diff preview for unanchored pull request changes links", async () => {
    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/pull/42/changes#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5",
      {
        async getGithubClient() {
          return {
            async request(route: string) {
              switch (route) {
                case "GET /repos/{owner}/{repo}":
                  return {
                    owner: { login: "octocat" },
                    name: "hello-world",
                    full_name: "octocat/hello-world",
                    private: true,
                  }
                case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
                  return {
                    number: 42,
                    title: "Ship the thing",
                    state: "open",
                    merged_at: null,
                    user: { login: "kris", avatar_url: "https://avatars.example/kris.png" },
                    base: { ref: "main" },
                    head: { ref: "feature/github-preview" },
                    additions: 12,
                    deletions: 4,
                    created_at: "2026-04-07T10:00:00.000Z",
                    updated_at: "2026-04-07T11:00:00.000Z",
                  }
                case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
                  return [
                    {
                      filename: "README.md",
                      status: "modified",
                      additions: 3,
                      deletions: 1,
                      patch: "@@ -1,3 +1,5 @@\n # Hello\n-old line\n same line\n+new line 1\n+new line 2",
                    },
                  ]
                default:
                  throw new Error(`Unexpected route: ${route}`)
              }
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toMatchObject({
      previewType: "github_diff",
      previewData: {
        type: "github_diff",
        data: {
          anchorSide: null,
          anchorStartLine: null,
          anchorEndLine: null,
          truncated: false,
          lines: [
            { type: "context", oldNumber: 1, newNumber: 1, text: "# Hello", selected: false },
            { type: "delete", oldNumber: 2, newNumber: null, text: "old line", selected: false },
            { type: "context", oldNumber: 3, newNumber: 2, text: "same line", selected: false },
            { type: "add", oldNumber: null, newNumber: 3, text: "new line 1", selected: false },
            { type: "add", oldNumber: null, newNumber: 4, text: "new line 2", selected: false },
          ],
        },
      },
    })
  })

  test("resolves GitHub blob refs that contain slashes", async () => {
    const requests: Array<{ route: string; params: Record<string, unknown> | undefined }> = []

    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/blob/feature/foo/src/app.ts#L2-L3",
      {
        async getGithubClient() {
          return {
            async request(route: string, params?: Record<string, unknown>) {
              requests.push({ route, params })

              if (route === "GET /repos/{owner}/{repo}") {
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: false,
                }
              }

              if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
                if (params?.ref === "feature" && params?.path === "foo/src/app.ts") {
                  throw new Error("not found")
                }

                if (params?.ref === "feature/foo" && params?.path === "src/app.ts") {
                  return {
                    type: "file",
                    content: Buffer.from("line1\nline2\nline3\nline4").toString("base64"),
                  }
                }
              }

              throw new Error(`Unexpected route: ${route}`)
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).not.toBeNull()
    expect(preview).toMatchObject({
      previewType: "github_file",
      previewData: {
        data: {
          renderMode: "snippet",
          ref: "feature/foo",
          path: "src/app.ts",
          startLine: 2,
          endLine: 3,
          lines: [
            { number: 2, text: "line2" },
            { number: 3, text: "line3" },
          ],
        },
      },
    })

    expect(requests).toEqual([
      { route: "GET /repos/{owner}/{repo}", params: { owner: "octocat", repo: "hello-world" } },
      {
        route: "GET /repos/{owner}/{repo}/contents/{path}",
        params: { owner: "octocat", repo: "hello-world", path: "foo/src/app.ts", ref: "feature" },
      },
      {
        route: "GET /repos/{owner}/{repo}/contents/{path}",
        params: { owner: "octocat", repo: "hello-world", path: "src/app.ts", ref: "feature/foo" },
      },
    ])
  })

  test("caps blob path resolution at the configured ref-depth instead of grinding through every segment", async () => {
    const requests: Array<{ route: string; params: Record<string, unknown> | undefined }> = []

    const preview = await fetchGitHubPreview(
      "ws_123",
      // 9 segments after `blob/` — none of the candidate splits resolve, so the
      // loop must bail out at the cap rather than issuing one request per segment.
      "https://github.com/octocat/hello-world/blob/a/b/c/d/e/f/g/h/i.ts",
      {
        async getGithubClient() {
          return {
            async request(route: string, params?: Record<string, unknown>) {
              requests.push({ route, params })

              if (route === "GET /repos/{owner}/{repo}") {
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: false,
                }
              }

              if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
                throw new Error("not found")
              }

              throw new Error(`Unexpected route: ${route}`)
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toBeNull()
    const contentsCalls = requests.filter((r) => r.route === "GET /repos/{owner}/{repo}/contents/{path}")
    // Cap is 5 attempts; without the cap this URL would issue 8.
    expect(contentsCalls).toHaveLength(5)
    expect(contentsCalls.map((r) => r.params?.ref)).toEqual(["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"])
  })

  test("normalizes issue label colors and rejects non-hex values", async () => {
    const preview = await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world/issues/7", {
      async getGithubClient() {
        return {
          async request(route: string) {
            if (route === "GET /repos/{owner}/{repo}") {
              return {
                owner: { login: "octocat" },
                name: "hello-world",
                full_name: "octocat/hello-world",
                private: false,
              }
            }
            if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
              return {
                number: 7,
                title: "Something broke",
                state: "open",
                user: { login: "kris", avatar_url: "https://avatars.example/kris.png" },
                labels: [
                  { name: "ok-hex", color: "ff8800" },
                  { name: "ok-hash-prefix", color: "#ABCDEF" },
                  { name: "bad-css", color: "red; background: url(x)" },
                  { name: "bad-too-short", color: "fff" },
                  { name: "bad-non-string", color: 123 },
                ],
                assignees: [],
                comments: 0,
                created_at: "2026-04-07T10:00:00.000Z",
                updated_at: "2026-04-07T11:00:00.000Z",
              }
            }
            throw new Error(`Unexpected route: ${route}`)
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).not.toBeNull()
    expect(preview?.previewData).toMatchObject({
      type: "github_issue",
      data: {
        labels: [
          { name: "ok-hex", color: "ff8800" },
          { name: "ok-hash-prefix", color: "abcdef" },
          { name: "bad-css", color: "999999" },
          { name: "bad-too-short", color: "999999" },
          { name: "bad-non-string", color: "999999" },
        ],
      },
    })
  })

  test("builds a README-backed file preview for tree URLs", async () => {
    const preview = await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world/tree/main", {
      async getGithubClient() {
        return {
          async request(route: string, params?: Record<string, unknown>) {
            if (route === "GET /repos/{owner}/{repo}") {
              return {
                owner: { login: "octocat" },
                name: "hello-world",
                full_name: "octocat/hello-world",
                private: true,
              }
            }

            if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
              if (params?.path === "README.md" && params?.ref === "main") {
                return {
                  type: "file",
                  content: Buffer.from("# Hello\nworld\n").toString("base64"),
                }
              }
            }

            throw new Error(`Unexpected route: ${route}`)
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).toMatchObject({
      previewType: "github_file",
      title: "README.md",
      description: "main · Markdown",
      previewData: {
        type: "github_file",
        data: {
          renderMode: "markdown",
          markdownContent: "# Hello\nworld",
          ref: "main",
          path: "README.md",
          lines: [
            { number: 1, text: "# Hello" },
            { number: 2, text: "world" },
          ],
        },
      },
    })
  })

  test("builds a README-backed file preview for repository URLs", async () => {
    const requests: Array<{ route: string; params: Record<string, unknown> | undefined }> = []

    const preview = await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world", {
      async getGithubClient() {
        return {
          async request(route: string, params?: Record<string, unknown>) {
            requests.push({ route, params })

            if (route === "GET /repos/{owner}/{repo}") {
              return {
                owner: { login: "octocat" },
                name: "hello-world",
                full_name: "octocat/hello-world",
                private: true,
                default_branch: "main",
              }
            }

            if (route === "GET /repos/{owner}/{repo}/readme") {
              return {
                type: "file",
                path: "README.md",
                content: Buffer.from("# Hello\n\nworld\n").toString("base64"),
              }
            }

            throw new Error(`Unexpected route: ${route}`)
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).toMatchObject({
      previewType: "github_file",
      title: "README.md",
      description: "main · Markdown",
      previewData: {
        type: "github_file",
        data: {
          renderMode: "markdown",
          markdownContent: "# Hello\n\nworld",
          ref: "main",
          path: "README.md",
        },
      },
    })

    expect(requests).toEqual([
      { route: "GET /repos/{owner}/{repo}", params: { owner: "octocat", repo: "hello-world" } },
      { route: "GET /repos/{owner}/{repo}/readme", params: { owner: "octocat", repo: "hello-world" } },
    ])
  })

  test("renders blob URLs to .md files as markdown", async () => {
    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/blob/main/docs/notes.md",
      {
        async getGithubClient() {
          return {
            async request(route: string, params?: Record<string, unknown>) {
              if (route === "GET /repos/{owner}/{repo}") {
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: false,
                }
              }

              if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
                if (params?.ref === "main" && params?.path === "docs/notes.md") {
                  return {
                    type: "file",
                    content: Buffer.from("# Notes\n\nSome body text.").toString("base64"),
                  }
                }
              }

              throw new Error(`Unexpected route: ${route}`)
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toMatchObject({
      previewType: "github_file",
      title: "docs/notes.md",
      previewData: {
        data: {
          renderMode: "markdown",
          markdownContent: "# Notes\n\nSome body text.",
          ref: "main",
          path: "docs/notes.md",
        },
      },
    })
  })

  test("renders .markdown blob URLs as markdown", async () => {
    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/blob/main/CHANGELOG.markdown",
      {
        async getGithubClient() {
          return {
            async request(route: string, params?: Record<string, unknown>) {
              if (route === "GET /repos/{owner}/{repo}") {
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: false,
                }
              }

              if (
                route === "GET /repos/{owner}/{repo}/contents/{path}" &&
                params?.ref === "main" &&
                params?.path === "CHANGELOG.markdown"
              ) {
                return {
                  type: "file",
                  content: Buffer.from("## v1\n\n- first release").toString("base64"),
                }
              }

              throw new Error(`Unexpected route: ${route}`)
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toMatchObject({
      previewType: "github_file",
      previewData: {
        data: {
          renderMode: "markdown",
          markdownContent: "## v1\n\n- first release",
        },
      },
    })
  })

  test("keeps snippet view for blob URLs to .md files when a line range is requested", async () => {
    const preview = await fetchGitHubPreview(
      "ws_123",
      "https://github.com/octocat/hello-world/blob/main/docs/notes.md#L2-L3",
      {
        async getGithubClient() {
          return {
            async request(route: string, params?: Record<string, unknown>) {
              if (route === "GET /repos/{owner}/{repo}") {
                return {
                  owner: { login: "octocat" },
                  name: "hello-world",
                  full_name: "octocat/hello-world",
                  private: false,
                }
              }

              if (
                route === "GET /repos/{owner}/{repo}/contents/{path}" &&
                params?.ref === "main" &&
                params?.path === "docs/notes.md"
              ) {
                return {
                  type: "file",
                  content: Buffer.from("# Notes\n\nSome body text.\nMore.").toString("base64"),
                }
              }

              throw new Error(`Unexpected route: ${route}`)
            },
          }
        },
      } as unknown as WorkspaceIntegrationService
    )

    expect(preview).toMatchObject({
      previewType: "github_file",
      previewData: {
        data: {
          renderMode: "snippet",
          markdownContent: null,
          startLine: 2,
          endLine: 3,
          lines: [
            { number: 2, text: "" },
            { number: 3, text: "Some body text." },
          ],
        },
      },
    })
  })

  test("keeps snippet view for blob URLs to non-markdown files", async () => {
    const preview = await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world/blob/main/src/app.ts", {
      async getGithubClient() {
        return {
          async request(route: string, params?: Record<string, unknown>) {
            if (route === "GET /repos/{owner}/{repo}") {
              return {
                owner: { login: "octocat" },
                name: "hello-world",
                full_name: "octocat/hello-world",
                private: false,
              }
            }

            if (
              route === "GET /repos/{owner}/{repo}/contents/{path}" &&
              params?.ref === "main" &&
              params?.path === "src/app.ts"
            ) {
              return {
                type: "file",
                content: Buffer.from("const x = 1").toString("base64"),
              }
            }

            throw new Error(`Unexpected route: ${route}`)
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).toMatchObject({
      previewType: "github_file",
      previewData: {
        data: {
          renderMode: "snippet",
          markdownContent: null,
        },
      },
    })
  })

  test("routes the client fetch to the repository owner's installation", async () => {
    let capturedOptions: unknown
    await fetchGitHubPreview("ws_123", "https://github.com/octocat/hello-world/pull/42", {
      async getGithubClient(_workspaceId: string, options?: unknown) {
        capturedOptions = options
        return null
      },
    } as unknown as WorkspaceIntegrationService)

    expect(capturedOptions).toMatchObject({ repoOwner: "octocat" })
  })
})

describe("checkGitHubRefreshGate", () => {
  test("routes the conditional gate fetch to the repository owner's installation", async () => {
    let capturedOptions: unknown
    const result = await checkGitHubRefreshGate("ws_123", "https://github.com/octocat/hello-world/pull/42", null, {
      async getGithubClient(_workspaceId: string, options?: unknown) {
        capturedOptions = options
        return {
          async requestConditional() {
            return { status: 304 as const, etag: null }
          },
        }
      },
    } as unknown as WorkspaceIntegrationService)

    expect(capturedOptions).toMatchObject({ repoOwner: "octocat" })
    expect(result).toEqual({ outcome: "not_modified" })
  })
})
