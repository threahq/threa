import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { LabelableResourceTypes } from "@threa/types"
import { db, type CachedLabelAssignment } from "@/db"
import {
  resetWorkspaceStoreCache,
  seedWorkspaceCache,
  useWorkspaceLabelAssignments,
  useWorkspaceMetadata,
  useWorkspaceUsers,
} from "./workspace-store"

describe("workspace store cache subscriptions", () => {
  beforeEach(() => {
    resetWorkspaceStoreCache()
  })

  it("rerenders existing array readers when the workspace cache is seeded", () => {
    const { result } = renderHook(() => useWorkspaceUsers("workspace_1"))

    expect(result.current).toEqual([])

    act(() => {
      seedWorkspaceCache("workspace_1", {
        workspace: {
          id: "workspace_1",
          name: "Workspace",
          slug: "workspace",
          createdAt: "2026-03-01T10:00:00Z",
          updatedAt: "2026-03-01T10:00:00Z",
          _cachedAt: Date.now(),
        },
        users: [
          {
            id: "user_1",
            workspaceId: "workspace_1",
            workosUserId: "workos_1",
            email: "kris@example.com",
            role: "owner",
            slug: "kris",
            name: "Kris",
            description: null,
            avatarUrl: null,
            timezone: null,
            locale: null,
            pronouns: null,
            phone: null,
            githubUsername: null,
            setupCompleted: true,
            joinedAt: "2026-03-01T10:00:00Z",
            _cachedAt: Date.now(),
          },
        ],
        streams: [],
        memberships: [],
        dmPeers: [],
        personas: [],
        bots: [],
      })
    })

    expect(result.current.map((user) => user.slug)).toEqual(["kris"])
  })

  it("rerenders existing singleton readers when the workspace cache is seeded", () => {
    const { result } = renderHook(() => useWorkspaceMetadata("workspace_1"))

    expect(result.current).toBeUndefined()

    act(() => {
      seedWorkspaceCache("workspace_1", {
        workspace: {
          id: "workspace_1",
          name: "Workspace",
          slug: "workspace",
          createdAt: "2026-03-01T10:00:00Z",
          updatedAt: "2026-03-01T10:00:00Z",
          _cachedAt: Date.now(),
        },
        users: [],
        streams: [],
        memberships: [],
        dmPeers: [],
        personas: [],
        bots: [],
        metadata: {
          id: "workspace_1",
          workspaceId: "workspace_1",
          emojis: [{ shortcode: "wave", emoji: "👋", type: "native", group: "people", order: 0, aliases: [] }],
          emojiWeights: {},
          commands: [],
          _cachedAt: Date.now(),
        },
      })
    })

    expect(result.current?.emojis.map((emoji) => emoji.shortcode)).toEqual(["wave"])
  })

  it("follows an emptied IDB rather than stranding the stale bootstrap cache", async () => {
    await db.labelAssignments.clear()
    const assignment: CachedLabelAssignment = {
      id: "workspace_1:stream:stream_1:label_1:user_1",
      workspaceId: "workspace_1",
      labelId: "label_1",
      resourceType: LabelableResourceTypes.STREAM,
      resourceId: "stream_1",
      userId: "user_1",
      assignedAt: "2026-03-01T10:00:00Z",
      _cachedAt: Date.now(),
    }

    // Bootstrap writes IDB and seeds the in-memory cache from the same data.
    await db.labelAssignments.put(assignment)
    act(() => {
      seedWorkspaceCache("workspace_1", {
        workspace: {
          id: "workspace_1",
          name: "Workspace",
          slug: "workspace",
          createdAt: "2026-03-01T10:00:00Z",
          updatedAt: "2026-03-01T10:00:00Z",
          _cachedAt: Date.now(),
        },
        users: [],
        streams: [],
        memberships: [],
        dmPeers: [],
        personas: [],
        bots: [],
        labelAssignments: [assignment],
      })
    })

    const { result } = renderHook(() => useWorkspaceLabelAssignments("workspace_1"))
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual([assignment.id]))

    // A socket unassign deletes the row from IDB but never touches the in-memory
    // cache. The reader must reflect the emptied IDB, not keep returning the
    // stale cached row until the next bootstrap.
    await act(async () => {
      await db.labelAssignments.delete(assignment.id)
    })

    await waitFor(() => expect(result.current).toEqual([]))
  })
})
