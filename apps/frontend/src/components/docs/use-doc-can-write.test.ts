import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import * as authModule from "@/auth"
import { resetWorkspaceStoreCache, seedWorkspaceCache } from "@/stores/workspace-store"
import { resetWorkspaceTableRegistry } from "@/stores/workspace-table-registry"
import { useDocCanWrite } from "./use-doc-can-write"

type Seed = Parameters<typeof seedWorkspaceCache>[1]
type CachedStream = Seed["streams"][number]
type CachedStreamMembership = Seed["memberships"][number]
type CachedWorkspaceUser = Seed["users"][number]

const WS = "ws_1"
const AT = "2026-01-01T00:00:00.000Z"

function row(id: string, overrides: Partial<CachedStream> = {}): CachedStream {
  return {
    id,
    workspaceId: WS,
    type: "channel",
    displayName: null,
    slug: id,
    description: null,
    visibility: "private",
    parentStreamId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    createdBy: "usr_viewer",
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    _cachedAt: 0,
    ...overrides,
  } as CachedStream
}

const viewer = {
  id: "usr_viewer",
  workspaceId: WS,
  workosUserId: "workos_viewer",
  name: "Viewer",
} as CachedWorkspaceUser
const channel = row("stream_chan")
const thread = row("stream_thread", {
  type: "thread",
  slug: null,
  parentStreamId: "stream_chan",
  rootStreamId: "stream_chan",
})
const doc = row("stream_doc", { type: "doc", slug: null, parentStreamId: "stream_thread", rootStreamId: "stream_chan" })

function membership(streamId: string): CachedStreamMembership {
  return {
    id: `${WS}:${streamId}`,
    workspaceId: WS,
    streamId,
    memberId: viewer.id,
    notificationLevel: null,
    joinedAt: AT,
    _cachedAt: 0,
  } as CachedStreamMembership
}

function seed(streams: CachedStream[], memberships: CachedStreamMembership[]) {
  seedWorkspaceCache(WS, {
    workspace: { id: WS, name: "W", slug: "w", createdAt: AT, updatedAt: AT, _cachedAt: 0 } as never,
    users: [viewer],
    streams,
    memberships,
    dmPeers: [],
    personas: [],
    bots: [],
  })
}

describe("useDocCanWrite", () => {
  beforeEach(() => {
    resetWorkspaceStoreCache()
    resetWorkspaceTableRegistry()
    vi.spyOn(authModule, "useUser").mockReturnValue({ id: "workos_viewer" } as ReturnType<typeof authModule.useUser>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function canWrite(stream: CachedStream) {
    return renderHook(() => useDocCanWrite(WS, stream)).result.current
  }

  it("lets a member of the doc's root write, and nobody else", () => {
    seed([channel, thread, doc], [membership("stream_chan")])
    const member = canWrite(doc)
    seed([channel, thread, doc], [membership("stream_thread")])
    expect({ member, threadMemberOnly: canWrite(doc) }).toEqual({ member: true, threadMemberOnly: false })
  })

  it("turns read-only when the doc or anything above it is archived", () => {
    const archivedHost = row("stream_thread", { ...thread, archivedAt: AT })
    seed([channel, archivedHost, doc], [membership("stream_chan")])
    const hostArchived = canWrite(doc)
    seed([channel, thread, doc], [membership("stream_chan")])
    expect({ hostArchived, docArchived: canWrite({ ...doc, archivedAt: AT }) }).toEqual({
      hostArchived: false,
      docArchived: false,
    })
  })

  it("never grants writing to a stream that is not a doc", () => {
    seed([channel, thread], [membership("stream_chan"), membership("stream_thread")])
    expect(canWrite(thread)).toBe(false)
  })
})
