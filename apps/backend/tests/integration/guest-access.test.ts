/**
 * Guests see only what they are let into. A viewer reads a root stream when it is `guest_public`,
 * when it is `public` and the viewer has the browse permission, or when they are a member of the
 * root; threads inherit from their root (INV-62). Browse is read from the user row.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { HttpError } from "@threahq/backend-common"
import {
  AuthorTypes,
  StreamErrorCodes,
  StreamTypes,
  Visibilities,
  type StreamReadOnlyReason,
  type StreamType,
  type Visibility,
} from "@threahq/types"
import { composeSql, type Querier } from "../../src/db"
import { computeAgentAccessSpec } from "../../src/features/agents"
import { findUserIdsWithoutBrowse, viewerLacksBrowseSql } from "../../src/features/workspaces"
import {
  StreamRepository,
  StreamService,
  assertStreamWritable,
  checkStreamAccess,
  listAccessibleStreamIds,
  listRoomReadableStreamIds,
  projectStreamForPrincipal,
  projectStreamsForPrincipal,
  usersReadingWithoutMembership,
  type StreamWritePrincipal,
} from "../../src/features/streams"
import { ActivityService } from "../../src/features/activity"
import { BotChannelService } from "../../src/features/api-keys"
import { SavedMessagesRepository, SavedMessagesService, resolveSavedView } from "../../src/features/saved-messages"
import { SearchRepository, resolveUserAccessibleStreamIds } from "../../src/features/search"
import { SyncLogRepository, type SyncLogEntryInput } from "../../src/features/sync"
import { StreamNotFoundError } from "../../src/lib/errors"
import { botId, messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { setupTestDatabase, withTransaction } from "./setup"

const noQueryExpected = {
  query: () => {
    throw new Error("no query expected")
  },
} as unknown as Querier

async function insertWorkspace(pool: Pool, label: string) {
  const id = workspaceId()
  await pool.query(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`, [
    id,
    `Guest access ${label}`,
    `guest-access-${label}-${id}`,
    userId(),
  ])
  return id
}

async function insertUser(pool: Pool, workspace: string, id: string, role: string) {
  await pool.query(
    `INSERT INTO users (id, workspace_id, workos_user_id, email, role, slug, name) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, workspace, `workos_${id}`, `${id}@test.local`, role, `u-${id}`, `User ${id}`]
  )
}

async function insertMirror(pool: Pool, workspace: string, id: string, roleSlugs: string[], status = "active") {
  await pool.query(
    `INSERT INTO workspace_user_permissions (workspace_id, workos_user_id, role_slugs, status, last_event_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [workspace, `workos_${id}`, roleSlugs, status]
  )
}

/** A guest and a member, plus a decoy workspace holding the same ids with the browse fact flipped. */
async function insertGuestAndMember(pool: Pool, label: string) {
  const ws = await insertWorkspace(pool, `${label}-a`)
  const decoyWs = await insertWorkspace(pool, `${label}-b`)
  const guest = userId()
  const member = userId()
  await insertUser(pool, ws, guest, "guest")
  await insertUser(pool, ws, member, "member")
  await insertUser(pool, decoyWs, guest, "member")
  await insertMirror(pool, decoyWs, guest, ["member"])
  await insertUser(pool, decoyWs, member, "guest")
  await insertMirror(pool, decoyWs, member, ["guest"])
  return { ws, guest, member }
}

async function insertStream(
  pool: Pool,
  workspace: string,
  stream: { id: string; visibility: Visibility; rootStreamId?: string; members?: string[]; archived?: boolean }
) {
  await pool.query(
    `INSERT INTO streams (id, workspace_id, type, visibility, parent_stream_id, root_stream_id, created_by, archived_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, CASE WHEN $7::boolean THEN NOW() END)`,
    [
      stream.id,
      workspace,
      stream.rootStreamId ? "thread" : "channel",
      stream.visibility,
      stream.rootStreamId ?? null,
      userId(),
      stream.archived ?? false,
    ]
  )
  for (const member of stream.members ?? []) {
    await pool.query(`INSERT INTO stream_members (workspace_id, stream_id, member_id) VALUES ($1, $2, $3)`, [
      workspace,
      stream.id,
      member,
    ])
  }
}

describe("viewer browse fact", () => {
  let pool: Pool
  let wsA: string
  let wsB: string

  interface BrowseCase {
    role: string
    mirror?: { slugs: string[]; status?: string }
    lacksBrowse: boolean
  }

  const cases: Record<string, BrowseCase> = {
    memberRole: { role: "member", lacksBrowse: false },
    adminRole: { role: "admin", lacksBrowse: false },
    ownerRole: { role: "owner", lacksBrowse: false },
    guestRole: { role: "guest", lacksBrowse: true },
    guestMirrorOverMemberRole: { role: "member", mirror: { slugs: ["guest"] }, lacksBrowse: true },
    memberMirrorOverGuestRole: { role: "guest", mirror: { slugs: ["member"] }, lacksBrowse: false },
    guestAndMemberMirror: { role: "guest", mirror: { slugs: ["guest", "member"] }, lacksBrowse: false },
    guestAndUnknownMirror: { role: "member", mirror: { slugs: ["guest", "wizard"] }, lacksBrowse: true },
    inactiveMemberMirrorOverGuestRole: {
      role: "guest",
      mirror: { slugs: ["member"], status: "inactive" },
      lacksBrowse: true,
    },
    inactiveGuestMirrorOverMemberRole: {
      role: "member",
      mirror: { slugs: ["guest"], status: "inactive" },
      lacksBrowse: false,
    },
    emptyMirrorOverGuestRole: { role: "guest", mirror: { slugs: [] }, lacksBrowse: true },
    unknownRole: { role: "wizard", lacksBrowse: true },
    unknownMirrorOverGuestRole: { role: "guest", mirror: { slugs: ["wizard"] }, lacksBrowse: true },
    unknownMirrorOverMemberRole: { role: "member", mirror: { slugs: ["wizard"] }, lacksBrowse: false },
  }

  const ids: Record<string, string> = {}
  const bot = botId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = await insertWorkspace(pool, "browse-a")
    wsB = await insertWorkspace(pool, "browse-b")

    for (const [label, seed] of Object.entries(cases)) {
      const id = userId()
      ids[label] = id
      await insertUser(pool, wsA, id, seed.role)
      if (seed.mirror) await insertMirror(pool, wsA, id, seed.mirror.slugs, seed.mirror.status)

      const decoyRole = seed.lacksBrowse ? "member" : "guest"
      await insertUser(pool, wsB, id, decoyRole)
      await insertMirror(pool, wsB, id, [decoyRole])
    }
    await insertUser(pool, wsB, bot, "guest")
  })

  afterAll(async () => {
    await pool.end()
  })

  const expectedLacksBrowse = Object.fromEntries([
    ...Object.entries(cases).map(([label, seed]) => [label, seed.lacksBrowse]),
    ["bot", false],
  ])

  test("should report who lacks browse when users are read in a batch", async () => {
    const lacking = await findUserIdsWithoutBrowse(pool, wsA, [...Object.values(ids), bot])

    expect(
      Object.fromEntries([...Object.entries(ids), ["bot", bot]].map(([label, id]) => [label, lacking.has(id)]))
    ).toEqual(expectedLacksBrowse)
  })

  test("should report who lacks browse when the condition is spliced into a statement", async () => {
    const lacksBrowse: Record<string, boolean> = {}
    for (const [label, id] of [...Object.entries(ids), ["bot", bot]]) {
      const result = await pool.query<{ lacks: boolean }>(composeSql`SELECT ${viewerLacksBrowseSql(wsA, id)} AS lacks`)
      lacksBrowse[label] = result.rows[0].lacks
    }

    expect(lacksBrowse).toEqual(expectedLacksBrowse)
  })
})

describe("stream access without membership", () => {
  let pool: Pool
  let wsA: string
  let wsB: string
  let guest: string
  let member: string

  type StreamKey =
    | "P"
    | "G"
    | "M"
    | "N"
    | "PG"
    | "TP"
    | "TPThreadMember"
    | "TG"
    | "TPG"
    | "TM"
    | "TN"
    | "TStale"
    | "TNThreadMember"
    | "TDangling"
    | "AP"
    | "AG"
    | "AM"
    | "AN"
  type MatrixKey = StreamKey | "missing" | "otherWorkspace"

  const streamIds = {} as Record<StreamKey, string>
  const missing = streamId()
  const otherWorkspace = streamId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    wsA = await insertWorkspace(pool, "access-a")
    wsB = await insertWorkspace(pool, "access-b")
    guest = userId()
    member = userId()
    await insertUser(pool, wsA, guest, "guest")
    await insertUser(pool, wsA, member, "member")

    // A user with the same id in the other workspace has the opposite browse fact, as does its mirror row.
    await insertUser(pool, wsB, guest, "member")
    await insertMirror(pool, wsB, guest, ["member"])
    await insertUser(pool, wsB, member, "guest")
    await insertMirror(pool, wsB, member, ["guest"])

    for (const key of [
      "P",
      "G",
      "M",
      "N",
      "PG",
      "TP",
      "TPThreadMember",
      "TG",
      "TPG",
      "TM",
      "TN",
      "TStale",
      "TNThreadMember",
      "TDangling",
      "AP",
      "AG",
      "AM",
      "AN",
    ] as const) {
      streamIds[key] = streamId()
    }

    const channels = [
      { key: "P", visibility: Visibilities.PUBLIC, members: [] },
      { key: "G", visibility: Visibilities.GUEST_PUBLIC, members: [] },
      { key: "M", visibility: Visibilities.PRIVATE, members: [guest, member] },
      { key: "N", visibility: Visibilities.PRIVATE, members: [] },
      { key: "PG", visibility: Visibilities.PUBLIC, members: [guest] },
    ] as const
    const channelVisibility = Object.fromEntries(channels.map((channel) => [channel.key, channel.visibility]))
    for (const channel of channels) {
      await insertStream(pool, wsA, {
        id: streamIds[channel.key],
        visibility: channel.visibility,
        members: [...channel.members],
      })
    }

    // TStale carries a public copy of its visibility under a private root; TNThreadMember has thread members but no root access.
    const threads = [
      { key: "TP", root: "P", members: [] },
      { key: "TPThreadMember", root: "P", members: [guest] },
      { key: "TG", root: "G", members: [] },
      { key: "TPG", root: "PG", members: [] },
      { key: "TM", root: "M", members: [] },
      { key: "TN", root: "N", members: [] },
      { key: "TStale", root: "N", members: [], ownVisibility: Visibilities.PUBLIC },
      { key: "TNThreadMember", root: "N", members: [guest, member] },
      { key: "AP", root: "P", members: [], archived: true },
      { key: "AG", root: "G", members: [], archived: true },
      { key: "AM", root: "M", members: [], archived: true },
      { key: "AN", root: "N", members: [], archived: true },
    ] as const
    for (const thread of threads) {
      await insertStream(pool, wsA, {
        id: streamIds[thread.key],
        visibility: "ownVisibility" in thread ? thread.ownVisibility : channelVisibility[thread.root],
        rootStreamId: streamIds[thread.root],
        members: [...thread.members],
        archived: "archived" in thread,
      })
    }
    await insertStream(pool, wsA, {
      id: streamIds.TDangling,
      visibility: Visibilities.PUBLIC,
      rootStreamId: streamId(),
      members: [guest, member],
    })

    // Other workspace: copies of A's streams under the same ids that would flip A's answers if a read crossed over.
    await insertStream(pool, wsB, { id: streamIds.N, visibility: Visibilities.GUEST_PUBLIC, members: [guest, member] })
    await insertStream(pool, wsB, { id: streamIds.G, visibility: Visibilities.PRIVATE })
    await insertStream(pool, wsB, { id: streamIds.P, visibility: Visibilities.PRIVATE, members: [guest, member] })
    await insertStream(pool, wsB, { id: otherWorkspace, visibility: Visibilities.GUEST_PUBLIC })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function matrixFor(viewer: string) {
    const keys = [...(Object.keys(streamIds) as StreamKey[]), "missing", "otherWorkspace"] as MatrixKey[]
    const outsiders: Record<"missing" | "otherWorkspace", string> = { missing, otherWorkspace }
    const idOf = (key: MatrixKey) => (key === "missing" || key === "otherWorkspace" ? outsiders[key] : streamIds[key])

    const accessible = await listAccessibleStreamIds(pool, wsA, viewer, keys.map(idOf))
    const checked: Partial<Record<MatrixKey, boolean>> = {}
    for (const key of keys) checked[key] = (await checkStreamAccess(pool, idOf(key), wsA, viewer)) !== null

    const readingWithoutMembership: Partial<Record<Visibility, boolean>> = {}
    for (const visibility of [Visibilities.PUBLIC, Visibilities.GUEST_PUBLIC]) {
      readingWithoutMembership[visibility] = (await usersReadingWithoutMembership(pool, wsA, visibility, [viewer])).has(
        viewer
      )
    }

    return {
      checkStreamAccess: checked,
      listAccessibleStreamIds: Object.fromEntries(keys.map((key) => [key, accessible.has(idOf(key))])),
      usersReadingWithoutMembership: readingWithoutMembership,
    }
  }

  test("should let a guest read only guest_public streams and streams they are in when they have no browse", async () => {
    const readable = {
      P: false,
      G: true,
      M: true,
      N: false,
      PG: true,
      TP: false,
      TPThreadMember: false,
      TG: true,
      TPG: true,
      TM: true,
      TN: false,
      TStale: false,
      TNThreadMember: false,
      TDangling: false,
      AP: false,
      AG: true,
      AM: true,
      AN: false,
      missing: false,
      otherWorkspace: false,
    }

    expect(await matrixFor(guest)).toEqual({
      checkStreamAccess: readable,
      listAccessibleStreamIds: readable,
      usersReadingWithoutMembership: { public: false, guest_public: true },
    })
  })

  test("should let a member read public and guest_public streams and the private streams they are in", async () => {
    const readable = {
      P: true,
      G: true,
      M: true,
      N: false,
      PG: true,
      TP: true,
      TPThreadMember: true,
      TG: true,
      TPG: true,
      TM: true,
      TN: false,
      TStale: false,
      TNThreadMember: false,
      TDangling: false,
      AP: true,
      AG: true,
      AM: true,
      AN: false,
      missing: false,
      otherWorkspace: false,
    }

    expect(await matrixFor(member)).toEqual({
      checkStreamAccess: readable,
      listAccessibleStreamIds: readable,
      usersReadingWithoutMembership: { public: true, guest_public: true },
    })
  })

  test("should read for no one without membership when the visibility is private or unknown", async () => {
    expect([
      await usersReadingWithoutMembership(noQueryExpected, wsA, Visibilities.PRIVATE, [guest, member]),
      await usersReadingWithoutMembership(noQueryExpected, wsA, "archived" as Visibility, [guest, member]),
    ]).toEqual([new Set(), new Set()])
  })

  test("should answer without a query when no users are asked about", async () => {
    expect([
      await usersReadingWithoutMembership(noQueryExpected, wsA, Visibilities.PUBLIC, []),
      await usersReadingWithoutMembership(noQueryExpected, wsA, Visibilities.GUEST_PUBLIC, []),
    ]).toEqual([new Set(), new Set()])
  })

  test("should let only users with browse read a public stream when a batch includes a bot and a guest", async () => {
    const bot = botId()

    expect(await usersReadingWithoutMembership(pool, wsA, Visibilities.PUBLIC, [guest, member, bot])).toEqual(
      new Set([member, bot])
    )
  })

  type Outcome = "hidden" | "writable" | `read-only:${StreamReadOnlyReason}`
  type Outcomes = Record<StreamKey | "otherWorkspace", Outcome>
  type Listed = Record<"active" | "channels" | "threads" | "archived", StreamKey[]>

  const grantlessBot = botId()
  const allKeys = () => [...(Object.keys(streamIds) as StreamKey[]), "missing", "otherWorkspace"] as const
  const idOfKey = (key: ReturnType<typeof allKeys>[number]) =>
    key === "missing" || key === "otherWorkspace" ? { missing, otherWorkspace }[key] : streamIds[key]
  const service = () => new StreamService(pool)
  const asUser = (id: string): StreamWritePrincipal => ({ kind: "user", userId: id })
  const NOT_A_MEMBER = "read-only:not_a_member"
  const ARCHIVED = "read-only:archived"

  const guestOutcomes: Outcomes = {
    P: "hidden",
    G: NOT_A_MEMBER,
    M: "writable",
    N: "hidden",
    PG: "writable",
    TP: "hidden",
    TPThreadMember: "hidden",
    TG: NOT_A_MEMBER,
    TPG: "writable",
    TM: "writable",
    TN: "hidden",
    TStale: "hidden",
    TNThreadMember: "hidden",
    TDangling: "hidden",
    AP: "hidden",
    AG: ARCHIVED,
    AM: ARCHIVED,
    AN: "hidden",
    otherWorkspace: "hidden",
  }

  const memberOutcomes: Outcomes = {
    P: NOT_A_MEMBER,
    G: NOT_A_MEMBER,
    M: "writable",
    N: "hidden",
    PG: NOT_A_MEMBER,
    TP: NOT_A_MEMBER,
    TPThreadMember: NOT_A_MEMBER,
    TG: NOT_A_MEMBER,
    TPG: NOT_A_MEMBER,
    TM: "writable",
    TN: "hidden",
    TStale: "hidden",
    TNThreadMember: "hidden",
    TDangling: "hidden",
    AP: ARCHIVED,
    AG: ARCHIVED,
    AM: ARCHIVED,
    AN: "hidden",
    otherWorkspace: "hidden",
  }

  const grantlessBotOutcomes: Outcomes = {
    P: NOT_A_MEMBER,
    G: NOT_A_MEMBER,
    M: "hidden",
    N: "hidden",
    PG: NOT_A_MEMBER,
    TP: NOT_A_MEMBER,
    TPThreadMember: NOT_A_MEMBER,
    TG: NOT_A_MEMBER,
    TPG: NOT_A_MEMBER,
    TM: "hidden",
    TN: "hidden",
    TStale: "hidden",
    TNThreadMember: "hidden",
    TDangling: "hidden",
    AP: ARCHIVED,
    AG: ARCHIVED,
    AM: "hidden",
    AN: "hidden",
    otherWorkspace: "hidden",
  }

  const guestListed: Listed = {
    active: ["G", "M", "PG", "TG", "TPG", "TM"],
    channels: ["G", "M", "PG"],
    threads: ["TG", "TPG", "TM"],
    archived: ["AG", "AM"],
  }

  const memberListed: Listed = {
    active: ["P", "G", "M", "PG", "TP", "TPThreadMember", "TG", "TPG", "TM"],
    channels: ["P", "G", "M", "PG"],
    threads: ["TP", "TPThreadMember", "TG", "TPG", "TM"],
    archived: ["AP", "AG", "AM"],
  }

  function keysOf(streams: readonly { id: string }[]): string[] {
    const keyById = new Map(Object.entries(streamIds).map(([key, id]) => [id, key]))
    return streams.map((stream) => keyById.get(stream.id) ?? `unknown:${stream.id}`).sort()
  }

  function expectedListings(listed: Listed) {
    const [active, channels, threads, archived] = [listed.active, listed.channels, listed.threads, listed.archived].map(
      (keys) => [...keys].sort()
    )
    return {
      list: active,
      listChannels: channels,
      listThreads: threads,
      listArchived: archived,
      listWithPreviews: active,
      listWithPreviewsChannels: channels,
      listWithPreviewsThreads: threads,
      listWithPreviewsArchived: archived,
      listArchivedStreams: archived,
    }
  }

  async function listingsFor(viewer: string) {
    const channels = { types: [StreamTypes.CHANNEL] as StreamType[] }
    const threads = { types: [StreamTypes.THREAD] as StreamType[] }
    const archived = { archiveStatus: ["archived" as const] }
    return {
      list: keysOf(await service().list(wsA, viewer)),
      listChannels: keysOf(await service().list(wsA, viewer, channels)),
      listThreads: keysOf(await service().list(wsA, viewer, threads)),
      listArchived: keysOf(await service().list(wsA, viewer, archived)),
      listWithPreviews: keysOf(await service().listWithPreviews(wsA, viewer)),
      listWithPreviewsChannels: keysOf(await service().listWithPreviews(wsA, viewer, channels)),
      listWithPreviewsThreads: keysOf(await service().listWithPreviews(wsA, viewer, threads)),
      listWithPreviewsArchived: keysOf(await service().listWithPreviews(wsA, viewer, archived)),
      listArchivedStreams: keysOf(await service().listArchivedStreams(wsA, viewer)),
    }
  }

  async function writeOutcome(attempt: () => Promise<unknown>): Promise<Outcome> {
    try {
      await attempt()
      return "writable"
    } catch (error) {
      if (error instanceof StreamNotFoundError) return "hidden"
      if (error instanceof HttpError && error.code === StreamErrorCodes.READ_ONLY) {
        return `read-only:${(error.details as { reason: StreamReadOnlyReason }).reason}`
      }
      throw error
    }
  }

  function projectedOutcome(projected: { readOnlyReason: StreamReadOnlyReason | null } | null | undefined): Outcome {
    if (!projected) return "hidden"
    return projected.readOnlyReason ? `read-only:${projected.readOnlyReason}` : "writable"
  }

  type Gate = "hidden" | "reached"

  async function gateOutcome(attempt: () => Promise<unknown>, reachedCodes: string[]): Promise<Gate> {
    try {
      await attempt()
    } catch (error) {
      if (error instanceof StreamNotFoundError) return "hidden"
      if (error instanceof HttpError && error.code && reachedCodes.includes(error.code)) return "reached"
      throw error
    }
    return "reached"
  }

  function gatesReachedWhere(outcomes: Outcomes): Record<string, Gate> {
    const gates = Object.entries(outcomes).map(([key, outcome]): [string, Gate] => [
      key,
      outcome === "hidden" ? "hidden" : "reached",
    ])
    return { ...Object.fromEntries(gates), missing: "hidden" }
  }

  async function writeAuthorityFor(principal: StreamWritePrincipal) {
    const keys = Object.keys(streamIds) as StreamKey[]
    const rows = await StreamRepository.findByIds(
      pool,
      wsA,
      keys.map((key) => streamIds[key])
    )
    const outside = await StreamRepository.findById(pool, wsB, otherWorkspace)
    if (!outside) throw new Error("fixture: the other-workspace stream is missing")
    const projectable = [
      ...keys.map((key) => [key, rows.find((row) => row.id === streamIds[key])!] as const),
      ["otherWorkspace", outside] as const,
    ]

    const projectedOne: Record<string, Outcome> = {}
    for (const [key, stream] of projectable) {
      projectedOne[key] = projectedOutcome(
        await projectStreamForPrincipal(pool, { workspaceId: wsA, stream, principal })
      )
    }
    const batch = await projectStreamsForPrincipal(pool, {
      workspaceId: wsA,
      streams: projectable.map(([, stream]) => stream),
      principal,
    })
    const batchById = new Map(batch.map((stream) => [stream.id, stream]))

    const asserted: Record<string, Outcome> = {}
    for (const key of allKeys()) {
      asserted[key] = await writeOutcome(() =>
        withTransaction(pool, (client) =>
          assertStreamWritable(client, { workspaceId: wsA, streamId: idOfKey(key), principal })
        )
      )
    }

    return {
      assertStreamWritable: asserted,
      projectStreamForPrincipal: projectedOne,
      projectStreamsForPrincipal: Object.fromEntries(
        projectable.map(([key, stream]) => [key, projectedOutcome(batchById.get(stream.id))])
      ),
    }
  }

  async function resolveWritableMessageStreamFor(viewer: string) {
    const outcomes: Record<string, Outcome> = {}
    for (const key of allKeys()) {
      outcomes[key] = await writeOutcome(() =>
        service().resolveWritableMessageStream({ workspaceId: wsA, userId: viewer, target: { streamId: idOfKey(key) } })
      )
    }
    return outcomes
  }

  async function lifecycleGatesFor(principal: StreamWritePrincipal) {
    const archive: Record<string, Gate> = {}
    const addMember: Record<string, Gate> = {}
    const removeMember: Record<string, Gate> = {}
    for (const key of allKeys()) {
      archive[key] = await gateOutcome(
        () => service().setStreamArchived(wsA, idOfKey(key), principal, true),
        ["FORBIDDEN", "CHANNEL_MANAGEMENT_FORBIDDEN"]
      )
      if (principal.kind === "user") {
        addMember[key] = await gateOutcome(
          () => service().addMember(idOfKey(key), userId(), wsA, principal.userId),
          ["MEMBER_NOT_FOUND"]
        )
        removeMember[key] = await gateOutcome(
          () => service().removeMember(idOfKey(key), userId(), wsA, principal.userId),
          ["LAST_MEMBER"]
        )
      }
    }
    return principal.kind === "user" ? { archive, addMember, removeMember } : { archive }
  }

  test("should resolve a guest's write authority by the root they read and belong to", async () => {
    expect({
      ...(await writeAuthorityFor(asUser(guest))),
      resolveWritableMessageStream: await resolveWritableMessageStreamFor(guest),
    }).toEqual({
      assertStreamWritable: { ...guestOutcomes, missing: "hidden" },
      projectStreamForPrincipal: guestOutcomes,
      projectStreamsForPrincipal: guestOutcomes,
      resolveWritableMessageStream: { ...guestOutcomes, missing: "hidden" },
    })
  })

  test("should resolve a member's write authority by the root they read and belong to", async () => {
    expect({
      ...(await writeAuthorityFor(asUser(member))),
      resolveWritableMessageStream: await resolveWritableMessageStreamFor(member),
    }).toEqual({
      assertStreamWritable: { ...memberOutcomes, missing: "hidden" },
      projectStreamForPrincipal: memberOutcomes,
      projectStreamsForPrincipal: memberOutcomes,
      resolveWritableMessageStream: { ...memberOutcomes, missing: "hidden" },
    })
  })

  test("should resolve a bot's write authority by grants and open roots when it has no grants", async () => {
    expect(await writeAuthorityFor({ kind: "bot", botId: grantlessBot })).toEqual({
      assertStreamWritable: { ...grantlessBotOutcomes, missing: "hidden" },
      projectStreamForPrincipal: grantlessBotOutcomes,
      projectStreamsForPrincipal: grantlessBotOutcomes,
    })
  })

  test("should let a guest reach the lifecycle gates only on the roots they read", async () => {
    const reached = gatesReachedWhere(guestOutcomes)

    expect(await lifecycleGatesFor(asUser(guest))).toEqual({
      archive: reached,
      addMember: reached,
      removeMember: reached,
    })
  })

  test("should let a member reach the lifecycle gates only on the roots they read", async () => {
    const reached = gatesReachedWhere(memberOutcomes)

    expect(await lifecycleGatesFor(asUser(member))).toEqual({
      archive: reached,
      addMember: reached,
      removeMember: reached,
    })
  })

  test("should let a bot with no grants reach the archive gate only on open roots", async () => {
    expect(await lifecycleGatesFor({ kind: "bot", botId: grantlessBot })).toEqual({
      archive: gatesReachedWhere(grantlessBotOutcomes),
    })
  })

  test("should list a guest only the streams whose root they read and the archived ones they may see", async () => {
    expect(await listingsFor(guest)).toEqual(expectedListings(guestListed))
  })

  test("should list a member the streams whose root they read and the archived ones they may see", async () => {
    expect(await listingsFor(member)).toEqual(expectedListings(memberListed))
  })

  describe("sync, saved, activity, search and bot reads", () => {
    const messageIds = {} as Record<StreamKey, string>
    const searchToken = `guestreach${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => String.fromCharCode(97 + (byte % 26))).join("")}`
    let actor: string
    let outsideMessage: string
    let sequence = 0

    // Direct thread membership is its own sync arm (message-move); these threads aren't part of the inherited-access matrix.
    const SYNC_EXCLUDED: StreamKey[] = ["TPThreadMember", "TNThreadMember", "TDangling"]
    const guestReads: StreamKey[] = ["G", "M", "PG", "TG", "TPG", "TM", "AG", "AM"]
    const memberReads: StreamKey[] = ["P", "G", "M", "PG", "TP", "TPThreadMember", "TG", "TPG", "TM", "AP", "AG", "AM"]
    const openToBots: StreamKey[] = ["P", "G", "PG", "TP", "TPThreadMember", "TG", "TPG", "AP", "AG"]
    const everyKey = () => Object.keys(streamIds) as StreamKey[]
    const sortedKeys = (keys: readonly string[]) => [...keys].sort()
    const keysOfIds = (ids: readonly string[]) => keysOf(ids.map((id) => ({ id })))

    async function insertMessage(workspace: string, stream: string, text: string) {
      const id = messageId()
      sequence += 1
      await pool.query(
        `INSERT INTO messages (id, workspace_id, stream_id, sequence, author_id, author_type, content_markdown, content_json, created_at)
         VALUES ($1, $2, $3, $4, $5, 'user', $6, '{}', NOW())`,
        [id, workspace, stream, sequence, actor, text]
      )
      return id
    }

    async function appendSync(workspace: string, entries: Array<Omit<SyncLogEntryInput, "outboxEventId">>) {
      const reserved = await pool.query<{ id: string }>(
        `SELECT nextval('outbox_id_seq') AS id FROM generate_series(1, $1)`,
        [entries.length]
      )
      await SyncLogRepository.appendForWorkspace(
        pool,
        workspace,
        entries.map((entry, index) => ({ ...entry, outboxEventId: BigInt(reserved.rows[index].id) }))
      )
    }

    beforeAll(async () => {
      actor = userId()
      await insertUser(pool, wsA, actor, "member")
      for (const key of everyKey()) {
        messageIds[key] = await insertMessage(wsA, streamIds[key], `${searchToken} ${key}`)
      }
      outsideMessage = await insertMessage(wsB, otherWorkspace, `${searchToken} other workspace`)

      // Every stream gets history from before and after the users joined M and PG; the other workspace holds decoys on the same stream ids.
      const syncKeys = everyKey().filter((key) => !SYNC_EXCLUDED.includes(key))
      const history = (eventType: string) =>
        syncKeys.map((key) => ({
          eventType,
          groups: [`stream:${streamIds[key]}`],
          payload: { key },
        }))
      // The (G, guest) join has no stream_members row: a guest who joined a guest_public channel and left still reads its history.
      const joins = [
        [streamIds.M, guest],
        [streamIds.M, member],
        [streamIds.PG, guest],
        [streamIds.G, guest],
      ]
      await appendSync(wsA, [
        ...history("test:before-join"),
        ...joins.map(([stream, joiner]) => ({
          eventType: "stream:member_added",
          groups: [`stream:${stream}`, `user:${joiner}`],
          payload: { workspaceId: wsA, streamId: stream, memberId: joiner },
        })),
        ...history("test:after-join"),
      ])
      await appendSync(wsB, [
        {
          eventType: "test:after-join",
          groups: [`stream:${streamIds.G}`, `stream:${streamIds.P}`],
          payload: { key: "decoy" },
        },
      ])
    }, 60_000)

    async function syncPhasesFor(viewer: string, workspace = wsA) {
      const entries = await SyncLogRepository.listEntriesForUser(pool, {
        workspaceId: workspace,
        userId: viewer,
        permissionGroups: [],
        after: 0n,
        limit: 1000,
      })
      const phases: Record<string, string[]> = {}
      for (const entry of entries) {
        if (!entry.eventType.startsWith("test:")) continue
        const { key } = entry.payload as { key: string }
        ;(phases[key] ??= []).push(entry.eventType.slice("test:".length))
      }
      return phases
    }

    test("should replay a guest's guest_public history in full and a public channel they joined from their join", async () => {
      const full = ["before-join", "after-join"]
      const fromJoin = ["after-join"]

      expect(await syncPhasesFor(guest)).toEqual({
        G: full,
        TG: full,
        AG: full,
        M: fromJoin,
        TM: fromJoin,
        AM: fromJoin,
        PG: fromJoin,
        TPG: fromJoin,
      })
    })

    test("should replay a member's public and guest_public history in full and a private channel they joined from their join", async () => {
      const full = ["before-join", "after-join"]
      const fromJoin = ["after-join"]

      expect(await syncPhasesFor(member)).toEqual({
        P: full,
        TP: full,
        AP: full,
        G: full,
        TG: full,
        AG: full,
        PG: full,
        TPG: full,
        M: fromJoin,
        TM: fromJoin,
        AM: fromJoin,
      })
    })

    test("should replay a public channel in full to a member with browse and from their join to a guest when both belong to it", async () => {
      const wsC = await insertWorkspace(pool, "access-c")
      const [browser, guestMember] = [userId(), userId()]
      const channel = streamId()
      await insertUser(pool, wsC, browser, "member")
      await insertUser(pool, wsC, guestMember, "guest")
      await insertStream(pool, wsC, { id: channel, visibility: Visibilities.PUBLIC, members: [browser, guestMember] })
      await appendSync(wsC, [
        { eventType: "test:before-join", groups: [`stream:${channel}`], payload: { key: "C" } },
        ...[browser, guestMember].map((joiner) => ({
          eventType: "stream:member_added",
          groups: [`stream:${channel}`, `user:${joiner}`],
          payload: { workspaceId: wsC, streamId: channel, memberId: joiner },
        })),
        { eventType: "test:after-join", groups: [`stream:${channel}`], payload: { key: "C" } },
      ])

      expect({
        browser: await syncPhasesFor(browser, wsC),
        guestMember: await syncPhasesFor(guestMember, wsC),
      }).toEqual({
        browser: { C: ["before-join", "after-join"] },
        guestMember: { C: ["after-join"] },
      })
    })

    async function saveOutcomesFor(viewer: string) {
      const service = new SavedMessagesService({ pool })
      const targets: Record<string, string> = {
        ...messageIds,
        missing: messageId(),
        otherWorkspace: outsideMessage,
      }
      const outcomes: Record<string, string> = {}
      for (const [key, target] of Object.entries(targets)) {
        try {
          await service.save({ workspaceId: wsA, userId: viewer, messageId: target, remindAt: null })
          outcomes[key] = "saved"
        } catch (error) {
          if (!(error instanceof HttpError) || !error.code) throw error
          outcomes[key] = error.code
        }
      }
      return outcomes
    }

    function expectedSaveOutcomes(reads: StreamKey[]) {
      const outcomes: Record<string, string> = {}
      for (const key of everyKey()) outcomes[key] = reads.includes(key) ? "saved" : "FORBIDDEN"
      return {
        ...outcomes,
        TDangling: "MESSAGE_NOT_FOUND",
        missing: "MESSAGE_NOT_FOUND",
        otherWorkspace: "MESSAGE_NOT_FOUND",
      }
    }

    test("should let a guest save only messages in streams they read", async () => {
      expect(await saveOutcomesFor(guest)).toEqual(expectedSaveOutcomes(guestReads))
    })

    test("should let a member save only messages in streams they read", async () => {
      expect(await saveOutcomesFor(member)).toEqual(expectedSaveOutcomes(memberReads))
    })

    async function unreadableSavedFor(viewer: string) {
      const rows = []
      for (const key of everyKey()) {
        const { saved } = await SavedMessagesRepository.upsert(pool, {
          workspaceId: wsA,
          userId: viewer,
          messageId: messageIds[key],
          streamId: streamIds[key],
          conversationId: null,
          remindAt: null,
        })
        rows.push(saved)
      }
      const views = await resolveSavedView(pool, wsA, viewer, rows)
      return keysOfIds(views.filter((view) => view.unavailableReason === "access_lost").map((view) => view.streamId!))
    }

    test("should flag a guest's saved messages as access lost when their stream is no longer readable", async () => {
      const unreadable = everyKey().filter((key) => !guestReads.includes(key))

      expect(await unreadableSavedFor(guest)).toEqual(sortedKeys(unreadable))
    })

    test("should flag a member's saved messages as access lost when their stream is no longer readable", async () => {
      const unreadable = everyKey().filter((key) => !memberReads.includes(key))

      expect(await unreadableSavedFor(member)).toEqual(sortedKeys(unreadable))
    })

    async function mentionedIn() {
      const service = new ActivityService({ pool })
      const mention = (id: string) => ({ type: "mention", attrs: { id, slug: `u-${id}`, mentionType: "user" } })
      const recipients: Record<string, string[]> = {}
      for (const key of everyKey()) {
        const activities = await service.processMessageMentions({
          workspaceId: wsA,
          streamId: streamIds[key],
          messageId: messageIds[key],
          actorId: actor,
          actorType: AuthorTypes.USER,
          contentMarkdown: "hey",
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [mention(guest), mention(member)] }] },
        })
        recipients[key] = activities.map((activity) => (activity.userId === guest ? "guest" : "member")).sort()
      }
      return recipients
    }

    test("should notify a mentioned guest only in streams they read and a mentioned member only in streams they read", async () => {
      const both = ["guest", "member"]
      const memberOnly = ["member"]

      expect(await mentionedIn()).toEqual({
        P: memberOnly,
        G: both,
        M: both,
        N: [],
        PG: both,
        TP: memberOnly,
        TPThreadMember: memberOnly,
        TG: both,
        TPG: both,
        TM: both,
        TN: [],
        TStale: [],
        TNThreadMember: [],
        TDangling: [],
        AP: memberOnly,
        AG: both,
        AM: both,
        AN: [],
      })
    })

    async function searchableFor(viewer: string) {
      const accessible = await resolveUserAccessibleStreamIds(pool, wsA, viewer, {
        archiveStatus: ["active", "archived"],
      })
      const found = await SearchRepository.fullTextSearch(pool, {
        workspaceId: wsA,
        query: searchToken,
        streamIds: accessible,
        filters: {},
        limit: 100,
        ranking: "improved",
      })
      const keyByMessage = new Map(Object.entries(messageIds).map(([key, id]) => [id, key]))
      return {
        accessibleStreams: keysOfIds(accessible),
        foundMessages: sortedKeys(found.map((message) => keyByMessage.get(message.id) ?? `unknown:${message.id}`)),
      }
    }

    test("should search a guest's messages only in the streams they read", async () => {
      expect(await searchableFor(guest)).toEqual({
        accessibleStreams: sortedKeys(guestReads),
        foundMessages: sortedKeys(guestReads),
      })
    })

    test("should search a member's messages only in the streams they read", async () => {
      expect(await searchableFor(member)).toEqual({
        accessibleStreams: sortedKeys(memberReads),
        foundMessages: sortedKeys(memberReads),
      })
    })

    test("should treat public and guest_public roots as open to a bot with no grants", async () => {
      const bots = new BotChannelService({ pool })
      const actionable: StreamKey[] = []
      for (const key of everyKey()) {
        if (await bots.isStreamActionableForBot(wsA, grantlessBot, streamIds[key], { allowArchived: true })) {
          actionable.push(key)
        }
      }

      expect({
        publicStreams: keysOfIds(await SearchRepository.getPublicStreams(pool, wsA)),
        publicStreamsIncludingArchived: keysOfIds(
          await SearchRepository.getPublicStreams(pool, wsA, { archiveStatus: ["active", "archived"] })
        ),
        actionable: sortedKeys(actionable),
      }).toEqual({
        publicStreams: sortedKeys(openToBots.filter((key) => !key.startsWith("A"))),
        publicStreamsIncludingArchived: sortedKeys(openToBots),
        actionable: sortedKeys(openToBots),
      })
    })
  })
})

describe("joining a public channel", () => {
  let pool: Pool
  let ws: string
  let guest: string
  let member: string

  type JoinKey = "P" | "G" | "M" | "TG" | "missing"
  const joinable = {} as Record<Exclude<JoinKey, "missing">, string>
  const missing = streamId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const seeded = await insertGuestAndMember(pool, "join")
    ws = seeded.ws
    guest = seeded.guest
    member = seeded.member

    for (const key of ["P", "G", "M", "TG"] as const) joinable[key] = streamId()
    await insertStream(pool, ws, { id: joinable.P, visibility: Visibilities.PUBLIC })
    await insertStream(pool, ws, { id: joinable.G, visibility: Visibilities.GUEST_PUBLIC })
    await insertStream(pool, ws, { id: joinable.M, visibility: Visibilities.PRIVATE })
    await insertStream(pool, ws, { id: joinable.TG, visibility: Visibilities.GUEST_PUBLIC, rootStreamId: joinable.G })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function joinOutcomes(viewer: string) {
    const outcomes: Record<string, string> = {}
    for (const key of ["P", "G", "M", "TG", "missing"] as const) {
      try {
        await new StreamService(pool).joinPublicChannel(key === "missing" ? missing : joinable[key], ws, viewer)
        outcomes[key] = "joined"
      } catch (error) {
        if (!(error instanceof HttpError) || !error.code) throw error
        outcomes[key] = error.code
      }
    }
    return outcomes
  }

  async function joinedKeys(viewer: string) {
    const rows = await pool.query<{ stream_id: string }>(
      `SELECT stream_id FROM stream_members WHERE workspace_id = $1 AND member_id = $2`,
      [ws, viewer]
    )
    const keyById = new Map(Object.entries(joinable).map(([key, id]) => [id, key]))
    return rows.rows.map((row) => keyById.get(row.stream_id)).sort()
  }

  test("should let a guest join only a guest_public channel", async () => {
    expect({ outcomes: await joinOutcomes(guest), joined: await joinedKeys(guest) }).toEqual({
      outcomes: {
        P: "NOT_PUBLIC_CHANNEL",
        G: "joined",
        M: "NOT_PUBLIC_CHANNEL",
        TG: "NOT_PUBLIC_CHANNEL",
        missing: "STREAM_NOT_FOUND",
      },
      joined: ["G"],
    })
  })

  test("should let a member join a public or guest_public channel", async () => {
    expect({ outcomes: await joinOutcomes(member), joined: await joinedKeys(member) }).toEqual({
      outcomes: {
        P: "joined",
        G: "joined",
        M: "NOT_PUBLIC_CHANNEL",
        TG: "NOT_PUBLIC_CHANNEL",
        missing: "STREAM_NOT_FOUND",
      },
      joined: ["G", "P"],
    })
  })
})

describe("room readability", () => {
  let pool: Pool
  let ws: string

  const keys = [
    "P",
    "G",
    "N",
    "TP",
    "staleThread",
    "privateRootThread",
    "memberRoom",
    "guestRoom",
    "guestThreadRoom",
    "publicGuestRoom",
    "guestPublicRoom",
  ] as const
  type RoomKey = (typeof keys)[number]
  const ids = {} as Record<RoomKey, string>
  const missingRoom = streamId()

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const seeded = await insertGuestAndMember(pool, "room")
    ws = seeded.ws
    const { guest, member } = seeded

    for (const key of keys) ids[key] = streamId()
    const channels = [
      { key: "P", visibility: Visibilities.PUBLIC },
      { key: "G", visibility: Visibilities.GUEST_PUBLIC },
      { key: "N", visibility: Visibilities.PRIVATE },
      { key: "memberRoom", visibility: Visibilities.PRIVATE, members: [member] },
      { key: "guestRoom", visibility: Visibilities.PRIVATE, members: [member, guest] },
      { key: "publicGuestRoom", visibility: Visibilities.PUBLIC, members: [guest] },
      { key: "guestPublicRoom", visibility: Visibilities.GUEST_PUBLIC },
    ] as const
    for (const channel of channels) {
      await insertStream(pool, ws, {
        id: ids[channel.key],
        visibility: channel.visibility,
        members: "members" in channel ? [...channel.members] : [],
      })
    }
    await insertStream(pool, ws, { id: ids.TP, visibility: Visibilities.PUBLIC, rootStreamId: ids.P })
    // A thread copies its root's visibility at creation and is never re-synced, so the root decides.
    await insertStream(pool, ws, { id: ids.staleThread, visibility: Visibilities.PUBLIC, rootStreamId: ids.N })
    await insertStream(pool, ws, { id: ids.privateRootThread, visibility: Visibilities.PRIVATE, rootStreamId: ids.P })
    await insertStream(pool, ws, {
      id: ids.guestThreadRoom,
      visibility: Visibilities.PRIVATE,
      rootStreamId: ids.guestRoom,
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function readableFor(room: string) {
    const keyById = new Map(Object.entries(ids).map(([key, id]) => [id, key]))
    const candidates = [ids.P, ids.G, ids.N, ids.TP, ids.staleThread, ids.privateRootThread, room]
    const readable = await listRoomReadableStreamIds(pool, ws, room, candidates)
    return [...readable].map((id) => keyById.get(id)).sort()
  }

  test("should let public and guest_public content through when no reader of the room lacks browse", async () => {
    expect(await readableFor(ids.memberRoom)).toEqual(["G", "P", "TP", "memberRoom", "privateRootThread"])
  })

  test("should let only guest_public content and the room itself through when a reader of the room lacks browse", async () => {
    expect({
      guestMemberRoom: await readableFor(ids.guestRoom),
      threadOfGuestMemberRoom: await readableFor(ids.guestThreadRoom),
      publicRoomWithGuestMember: await readableFor(ids.publicGuestRoom),
    }).toEqual({
      guestMemberRoom: ["G", "guestRoom"],
      threadOfGuestMemberRoom: ["G", "guestThreadRoom"],
      publicRoomWithGuestMember: ["G", "publicGuestRoom"],
    })
  })

  test("should let only guest_public content through when the room is guest_public or does not exist", async () => {
    expect({
      guestPublicRoom: await readableFor(ids.guestPublicRoom),
      missingRoom: await readableFor(missingRoom),
    }).toEqual({
      guestPublicRoom: ["G", "guestPublicRoom"],
      missingRoom: ["G"],
    })
  })
})

describe("agent research scope", () => {
  let pool: Pool
  let ws: string
  let member: string

  const keys = [
    "P",
    "G",
    "N",
    "publicRoom",
    "publicGuestRoom",
    "guestPublicRoom",
    "guestPrivateRoom",
    "guestPrivateRoomThread",
    "memberPrivateRoom",
    "orphanThread",
    "archivedChannel",
    "publicThread",
  ] as const
  type ScopeKey = (typeof keys)[number]
  type AgentScopeOptions = Parameters<typeof SearchRepository.getAccessibleStreamsForAgent>[3]
  const ids = {} as Record<ScopeKey, string>

  beforeAll(async () => {
    pool = await setupTestDatabase()
    const seeded = await insertGuestAndMember(pool, "scope")
    ws = seeded.ws
    member = seeded.member
    const { guest } = seeded

    for (const key of keys) ids[key] = streamId()
    const channels = [
      { key: "P", visibility: Visibilities.PUBLIC },
      { key: "G", visibility: Visibilities.GUEST_PUBLIC },
      { key: "N", visibility: Visibilities.PRIVATE },
      { key: "publicRoom", visibility: Visibilities.PUBLIC, members: [member] },
      { key: "publicGuestRoom", visibility: Visibilities.PUBLIC, members: [member, guest] },
      { key: "guestPublicRoom", visibility: Visibilities.GUEST_PUBLIC, members: [member] },
      { key: "guestPrivateRoom", visibility: Visibilities.PRIVATE, members: [member, guest] },
      { key: "memberPrivateRoom", visibility: Visibilities.PRIVATE, members: [member] },
    ] as const
    for (const channel of channels) {
      await insertStream(pool, ws, {
        id: ids[channel.key],
        visibility: channel.visibility,
        members: "members" in channel ? [...channel.members] : [],
      })
    }
    await insertStream(pool, ws, {
      id: ids.guestPrivateRoomThread,
      visibility: Visibilities.PRIVATE,
      rootStreamId: ids.guestPrivateRoom,
    })
    await insertStream(pool, ws, { id: ids.orphanThread, visibility: Visibilities.PRIVATE, rootStreamId: streamId() })
    await insertStream(pool, ws, { id: ids.archivedChannel, visibility: Visibilities.PUBLIC, archived: true })
    await insertStream(pool, ws, { id: ids.publicThread, visibility: Visibilities.PUBLIC, rootStreamId: ids.P })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function readableFor(
    room: string,
    {
      among = [ids.P, ids.G, ids.N, ids.guestPrivateRoomThread],
      options,
    }: { among?: string[]; options?: AgentScopeOptions } = {}
  ) {
    const stream = await StreamRepository.findById(pool, ws, room)
    if (!stream) throw new Error(`room ${room} was not seeded`)
    const spec = await computeAgentAccessSpec(pool, { stream, invokingUserId: member })
    const readable = new Set(await SearchRepository.getAccessibleStreamsForAgent(pool, spec, ws, options))
    const keyById = new Map(Object.entries(ids).map(([key, id]) => [id, key]))
    const probes = [...among, room]
    return probes
      .filter((id) => readable.has(id))
      .map((id) => keyById.get(id))
      .sort()
  }

  test("should let an agent read public and guest_public channels when its public channel has no guest members", async () => {
    expect(await readableFor(ids.publicRoom)).toEqual(["G", "P", "publicRoom"])
  })

  test("should withhold public channels from an agent when its public channel has a guest member", async () => {
    expect(await readableFor(ids.publicGuestRoom)).toEqual(["G", "publicGuestRoom"])
  })

  test("should withhold public channels from an agent when its channel is guest_public", async () => {
    expect(await readableFor(ids.guestPublicRoom)).toEqual(["G", "guestPublicRoom"])
  })

  test("should withhold public channels but keep the room and its threads when its private channel has a guest member", async () => {
    expect(await readableFor(ids.guestPrivateRoom)).toEqual(["G", "guestPrivateRoom", "guestPrivateRoomThread"])
  })

  test("should let an agent read public and guest_public channels when its private channel has no guest members", async () => {
    expect(await readableFor(ids.memberPrivateRoom)).toEqual(["G", "P", "memberPrivateRoom"])
  })

  test("should limit an agent to guest_public channels when its thread has no root", async () => {
    expect(await readableFor(ids.orphanThread)).toEqual(["G"])
  })

  test("should drop archived and non-channel streams from what an agent reads when it asks for active channels", async () => {
    const among = [ids.P, ids.archivedChannel, ids.publicThread]
    const activeChannels: AgentScopeOptions = { archiveStatus: ["active"], streamTypes: [StreamTypes.CHANNEL] }
    expect({
      everything: await readableFor(ids.publicRoom, { among, options: { archiveStatus: ["active", "archived"] } }),
      activeChannels: await readableFor(ids.publicRoom, { among, options: activeChannels }),
      privateRoomActiveChannels: await readableFor(ids.guestPrivateRoom, {
        among: [ids.guestPrivateRoomThread],
        options: activeChannels,
      }),
    }).toEqual({
      everything: ["P", "archivedChannel", "publicRoom", "publicThread"],
      activeChannels: ["P", "publicRoom"],
      privateRoomActiveChannels: ["guestPrivateRoom"],
    })
  })
})
