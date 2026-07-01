import { describe, expect, test } from "bun:test"
import { fetchLinearPreview } from "./linear-preview"
import type { WorkspaceIntegrationService } from "../workspace-integrations"

interface MockClientInput {
  handler: (query: string, variables: Record<string, unknown>) => unknown
  organizationUrlKey?: string
  organizationId?: string
  organizationName?: string
}

function makeService(input: MockClientInput): WorkspaceIntegrationService {
  const fake = {
    async getLinearClient() {
      return {
        organization: {
          organizationId: input.organizationId ?? "org_1",
          organizationName: input.organizationName ?? "Threa",
          organizationUrlKey: input.organizationUrlKey ?? "threa",
        },
        async request(query: string, variables: Record<string, unknown> = {}) {
          return input.handler(query, variables)
        },
      }
    },
  }
  return fake as unknown as WorkspaceIntegrationService
}

describe("fetchLinearPreview", () => {
  test("builds a rich issue preview", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/issue/ENG-123/ship-the-thing",
      makeService({
        handler: (_query, variables) => {
          expect(variables).toEqual({ id: "ENG-123" })
          return {
            issue: {
              id: "iss_1",
              identifier: "ENG-123",
              title: "Ship the thing",
              priority: 2,
              priorityLabel: "High",
              estimate: 3,
              dueDate: "2026-04-30",
              description: "Coordinate backend and frontend rollout before launch.",
              state: { name: "In Progress", type: "started", color: "#f2c94c" },
              assignee: { id: "u_1", name: "Kris", displayName: "Kris", avatarUrl: "https://avatars/kris.png" },
              team: { key: "ENG", name: "Engineering" },
              labels: { nodes: [{ name: "bug", color: "#eb5757" }] },
              project: { id: "prj_1", name: "Launch" },
              createdAt: "2026-04-01T10:00:00.000Z",
              updatedAt: "2026-04-10T12:00:00.000Z",
            },
          }
        },
      })
    )

    expect(preview).toMatchObject({
      previewType: "linear_issue",
      siteName: "Linear",
      status: "completed",
      previewData: {
        type: "linear_issue",
        organization: { urlKey: "threa" },
        data: {
          identifier: "ENG-123",
          title: "Ship the thing",
          summary: "Coordinate backend and frontend rollout before launch.",
          state: { name: "In Progress", type: "started" },
          priority: { label: "High", value: 2 },
          team: { key: "ENG", name: "Engineering" },
          assignee: { name: "Kris" },
          projectName: "Launch",
          labels: [{ name: "bug" }],
        },
      },
    })
  })

  test("builds a comment preview with parent issue context", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      makeService({
        handler: (_query, variables) => {
          expect(variables).toEqual({ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })
          return {
            comment: {
              id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
              url: "https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
              body: "Agree, let's merge after review.",
              createdAt: "2026-04-10T12:00:00.000Z",
              user: { id: "u_1", name: "Kris", displayName: "Kris", avatarUrl: null },
              issue: {
                identifier: "ENG-123",
                title: "Ship the thing",
                team: { key: "ENG", name: "Engineering" },
                state: { name: "In Progress", type: "started", color: "#f2c94c" },
              },
            },
          }
        },
      })
    )

    expect(preview).toMatchObject({
      previewType: "linear_comment",
      previewData: {
        data: {
          body: "Agree, let's merge after review.",
          truncated: false,
          author: { name: "Kris" },
          parent: {
            identifier: "ENG-123",
            title: "Ship the thing",
            team: { key: "ENG" },
          },
        },
      },
    })
  })

  test("matches short Linear comment fragments against comment URLs", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4",
      makeService({
        handler: (_query, variables) => {
          if ("id" in variables) return { comment: null }
          expect(variables).toEqual({ issueId: "ENG-123" })
          return {
            issue: {
              identifier: "ENG-123",
              title: "Ship the thing",
              team: { key: "ENG", name: "Engineering" },
              state: { name: "In Progress", type: "started", color: "#f2c94c" },
              comments: {
                nodes: [
                  {
                    id: "comment_opaque_id",
                    url: "https://linear.app/threa/issue/ENG-123/title#comment-a1b2c3d4",
                    body: "Short fragment comment.",
                    createdAt: "2026-04-10T12:00:00.000Z",
                    user: { id: "u_1", name: "Kris", displayName: "Kris", avatarUrl: null },
                  },
                ],
              },
            },
          }
        },
      })
    )

    expect(preview).toMatchObject({
      previewType: "linear_comment",
      previewData: { data: { body: "Short fragment comment.", parent: { identifier: "ENG-123" } } },
    })
  })

  test("truncates long comment bodies to 320 characters", async () => {
    const body = "x".repeat(400)
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/issue/ENG-5/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      makeService({
        handler: (query) => {
          if (query.includes("comment(id:")) {
            return {
              comment: {
                id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                url: "https://linear.app/threa/issue/ENG-5/title#comment-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                body,
                createdAt: "2026-04-10T12:00:00.000Z",
                user: null,
                issue: {
                  identifier: "ENG-5",
                  title: "Long",
                  team: { key: "ENG", name: "Engineering" },
                  state: { name: "Backlog", type: "backlog", color: "#bbb" },
                },
              },
            }
          }
          throw new Error("direct comment lookup should resolve full comment ids")
        },
      })
    )

    const data = (preview?.previewData as { data?: { body: string; truncated: boolean } } | null | undefined)?.data
    expect(data?.truncated).toBe(true)
    expect(data?.body.length).toBeLessThanOrEqual(321) // 320 chars + trailing ellipsis
    expect(data?.body.endsWith("…")).toBe(true)
  })

  test("builds a project preview via project lookup", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/project/launch-rocket-abc123/overview",
      makeService({
        handler: (_query, variables) => {
          expect(variables).toEqual({ id: "launch-rocket-abc123" })
          return {
            project: {
              id: "prj_1",
              name: "Launch Rocket",
              description: "Get to orbit by Q3",
              state: "started",
              progress: 0.42,
              startDate: "2026-01-01",
              targetDate: "2026-09-01",
              lead: { id: "u_1", name: "Kris", displayName: "Kris", avatarUrl: null },
              initiative: { id: "init_1", name: "Bugs, maintenance & improvements" },
            },
          }
        },
      })
    )

    expect(preview).toMatchObject({
      previewType: "linear_project",
      previewData: {
        data: {
          name: "Launch Rocket",
          description: "Get to orbit by Q3",
          status: "started",
          progress: 0.42,
          lead: { name: "Kris" },
          initiativeName: "Bugs, maintenance & improvements",
        },
      },
    })
  })

  test("falls back to a trailing project short id when the full URL slug is not resolvable", async () => {
    const calls: Record<string, unknown>[] = []
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/project/smaller-improvements-2026-h1-623f5efd5685/issues",
      makeService({
        handler: (_query, variables) => {
          calls.push(variables)
          if (variables.id === "smaller-improvements-2026-h1-623f5efd5685") return { project: null }
          expect(variables).toEqual({ id: "623f5efd5685" })
          return {
            project: {
              id: "prj_1",
              name: "Smaller improvements 2026 H1",
              description: null,
              state: "started",
              progress: 0.2,
              startDate: null,
              targetDate: null,
              lead: null,
              initiative: null,
            },
          }
        },
      })
    )

    expect(calls).toEqual([{ id: "smaller-improvements-2026-h1-623f5efd5685" }, { id: "623f5efd5685" }])
    expect(preview).toMatchObject({
      previewType: "linear_project",
      previewData: { data: { name: "Smaller improvements 2026 H1" } },
    })
  })

  test("builds a document preview via slugId filter", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/document/design-doc-xyz789",
      makeService({
        handler: (_query, variables) => {
          expect(variables).toEqual({ slugId: "design-doc-xyz789" })
          return {
            documents: {
              nodes: [
                {
                  id: "doc_1",
                  title: "Design Doc",
                  content: "Architecture overview and design rationale.",
                  createdAt: "2026-04-01T10:00:00.000Z",
                  updatedAt: "2026-04-10T12:00:00.000Z",
                  updatedBy: { id: "u_1", name: "Kris", displayName: "Kris", avatarUrl: null },
                  project: { id: "prj_1", name: "Launch" },
                },
              ],
            },
          }
        },
      })
    )

    expect(preview).toMatchObject({
      previewType: "linear_document",
      previewData: {
        data: {
          title: "Design Doc",
          summary: "Architecture overview and design rationale.",
          parentProject: { id: "prj_1", name: "Launch" },
        },
      },
    })
  })

  test("returns null when workspace slug does not match the connected Linear organization", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/other-org/issue/ENG-123",
      makeService({
        organizationUrlKey: "threa",
        handler: () => {
          throw new Error("should not be called — URL workspace slug mismatch should short-circuit")
        },
      })
    )

    expect(preview).toBeNull()
  })

  test("returns null when no active Linear integration is available", async () => {
    const preview = await fetchLinearPreview("ws_123", "https://linear.app/threa/issue/ENG-123", {
      async getLinearClient() {
        return null
      },
    } as unknown as WorkspaceIntegrationService)

    expect(preview).toBeNull()
  })

  test("returns null when the entity is not found", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://linear.app/threa/issue/ENG-999",
      makeService({ handler: () => ({ issue: null }) })
    )

    expect(preview).toBeNull()
  })

  test("returns null for non-Linear URLs", async () => {
    const preview = await fetchLinearPreview(
      "ws_123",
      "https://example.com/not-linear",
      makeService({ handler: () => ({}) })
    )
    expect(preview).toBeNull()
  })
})
