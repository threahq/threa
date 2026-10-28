import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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
  role: "member",
} as CachedWorkspaceUser
const guest = {
  id: "usr_guest",
  workspaceId: WS,
  workosUserId: "workos_guest",
  name: "Guest",
  role: "guest",
} as CachedWorkspaceUser
const channel = row("stream_chan")
const dm = row("stream_dm", { type: "dm", slug: null })
const scratchpad = row("stream_pad", { type: "scratchpad", slug: null })

function docUnder(root: CachedStream, overrides: Partial<CachedStream> = {}): CachedStream {
  return row(`stream_doc_${root.id}`, {
    type: "doc",
    slug: null,
    parentStreamId: root.id,
    rootStreamId: root.id,
    ...overrides,
  })
}

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

function seed(streams: CachedStream[], memberships: CachedStreamMembership[], dmPeers: Seed["dmPeers"] = []) {
  seedWorkspaceCache(WS, {
    workspace: { id: WS, name: "W", slug: "w", createdAt: AT, updatedAt: AT, _cachedAt: 0 } as never,
    users: [viewer, guest],
    streams,
    memberships,
    dmPeers,
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
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    return renderHook(() => useDocCanWrite(WS, stream), { wrapper }).result.current
  }

  it("lets a member of the doc's channel, DM or scratchpad root write, and nobody else", () => {
    const roots = [channel, dm, scratchpad]
    const docs = roots.map((root) => docUnder(root))
    seed(
      [...roots, ...docs],
      roots.map((root) => membership(root.id))
    )
    const members = docs.map(canWrite)
    seed([...roots, ...docs], [])
    expect({ members, nonMembers: docs.map(canWrite) }).toEqual({
      members: [true, true, true],
      nonMembers: [false, false, false],
    })
  })

  it("turns read-only when the doc or anything above it is archived", () => {
    const doc = docUnder(channel)
    seed([{ ...channel, archivedAt: AT }, doc], [membership(channel.id)])
    const rootArchived = canWrite(doc)
    seed([channel, doc], [membership(channel.id)])
    expect({ rootArchived, docArchived: canWrite({ ...doc, archivedAt: AT }) }).toEqual({
      rootArchived: false,
      docArchived: false,
    })
  })

  it("is read-only under a DM the guest DM policy closed", () => {
    const doc = docUnder(dm)
    seed(
      [dm, doc],
      [membership(dm.id)],
      [{ id: `${WS}:${dm.id}`, workspaceId: WS, userId: guest.id, streamId: dm.id, _cachedAt: 0 }]
    )
    expect(canWrite(doc)).toBe(false)
  })

  it("is read-only under a shared copy or a disconnected root", () => {
    const shared = row("stream_shared", { originWorkspaceId: "ws_partner" })
    const disconnected = row("stream_gone", { originWorkspaceId: "ws_partner", disconnectedAt: AT })
    const sharedDoc = docUnder(shared)
    const disconnectedDoc = docUnder(disconnected)
    seed([shared, disconnected, sharedDoc, disconnectedDoc], [membership(shared.id), membership(disconnected.id)])
    expect({ shared: canWrite(sharedDoc), disconnected: canWrite(disconnectedDoc) }).toEqual({
      shared: false,
      disconnected: false,
    })
  })

  it("is unresolved while the viewer's workspace user is not loaded", () => {
    const doc = docUnder(channel)
    seed([channel, doc], [membership(channel.id)])
    vi.spyOn(authModule, "useUser").mockReturnValue(null as ReturnType<typeof authModule.useUser>)
    expect(canWrite(doc)).toBeNull()
  })

  it("never grants writing to a stream that is not a doc", () => {
    seed([channel], [membership(channel.id)])
    expect(canWrite(channel)).toBe(false)
  })
})
