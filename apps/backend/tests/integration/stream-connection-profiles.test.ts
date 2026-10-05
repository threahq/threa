import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import {
  AuthorTypes,
  bridgeEventsSchema,
  bridgeManifestSchema,
  bridgeProfilesSchema,
  type BridgeEvents,
  type BridgeManifest,
  type BridgeProfiles,
  type StreamConnectionSnapshot,
} from "@threahq/types"
import { streamConnectionId } from "@threahq/backend-common"
import {
  addTestMember,
  createTestStorage,
  setupIsolatedTestDatabase,
  testContentJson,
  testMessageContent,
} from "./setup"
import { EventService } from "../../src/features/messaging"
import { StreamRepository } from "../../src/features/streams"
import { FeatureFlagOverrideRepository, FeatureFlagService } from "../../src/features/feature-flags"
import { AVATAR_SIZES, AvatarService, UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import {
  BridgeClient,
  StreamConnectionExportService,
  StreamConnectionForwardService,
  StreamConnectionPokeHandler,
  StreamConnectionProfileService,
  StreamConnectionPullService,
  StreamConnectionRepository,
  StreamConnectionWriteService,
} from "../../src/features/stream-connections"
import { JobQueues } from "../../src/lib/queue"
import type { OutboxEvent } from "../../src/lib/outbox"
import { streamId, userId, workspaceId } from "../../src/lib/id"

type Address = Parameters<BridgeClient["getManifest"]>[0]

interface Ends {
  exporter: StreamConnectionExportService
  writer: StreamConnectionWriteService
  avatarService: AvatarService
}

/** A user's avatar file as the public avatar route serves it, where a file storage can't find is a 404. */
async function fetchAvatarFile(
  avatarService: AvatarService,
  params: { workspaceId: string; userId: string; file: string }
): Promise<Buffer | null> {
  try {
    const stream = await avatarService.streamAvatarFile(params)
    if (!stream) return null
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  } catch {
    return null
  }
}

/** Answers every end's bridge calls in-process: all ends share one database and one bucket. */
class DirectBridgeClient extends BridgeClient {
  constructor(private readonly ends: Ends) {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async getManifest(address: Address): Promise<BridgeManifest> {
    return bridgeManifestSchema.parse(await this.ends.exporter.getManifest(address))
  }

  override async listEvents(
    address: Address,
    params: Parameters<BridgeClient["listEvents"]>[1]
  ): Promise<BridgeEvents> {
    return bridgeEventsSchema.parse(await this.ends.exporter.listEvents({ ...address, ...params }))
  }

  override sendMessage(address: Address, params: Parameters<BridgeClient["sendMessage"]>[1]) {
    return this.ends.writer.sendMessage({ ...address, ...params })
  }

  override async getProfiles(address: Address, userIds: string[]): Promise<BridgeProfiles> {
    return bridgeProfilesSchema.parse(await this.ends.exporter.getProfiles({ ...address, userIds }))
  }

  override getAvatarFile(params: Parameters<BridgeClient["getAvatarFile"]>[0]): Promise<Buffer | null> {
    return fetchAvatarFile(this.ends.avatarService, params)
  }
}

/** Runs `meanwhile` after the other end answers a profiles request, before the refresh writes. */
class InterruptedBridgeClient extends DirectBridgeClient {
  constructor(
    ends: Ends,
    private readonly meanwhile: () => Promise<unknown>
  ) {
    super(ends)
  }

  override async getProfiles(address: Address, userIds: string[]): Promise<BridgeProfiles> {
    const answer = await super.getProfiles(address, userIds)
    await this.meanwhile()
    return answer
  }
}

/** Records the profile pokes a handler sends instead of sending them. */
class RecordingBridgeClient extends BridgeClient {
  readonly profilePokes: Address[] = []

  constructor() {
    super({ routerUrl: "http://bridge.invalid", apiKey: "unused" })
  }

  override async poke(): Promise<void> {}

  override async pokeProfiles(address: Address): Promise<void> {
    this.profilePokes.push(address)
  }
}

class TestPokeHandler extends StreamConnectionPokeHandler {
  run(events: OutboxEvent[]) {
    return this.processBatch(events)
  }
}

describe("Profiles of copied users kept current across a shared channel", () => {
  let pool: Pool
  let cleanup: () => Promise<void>
  let featureFlagService: FeatureFlagService
  let eventService: EventService
  let avatarService: AvatarService
  let ends: Ends
  let bridge: DirectBridgeClient
  let pullService: StreamConnectionPullService
  let forwardService: StreamConnectionForwardService
  let profileService: StreamConnectionProfileService
  let nextToken = 1_700_000_000_000

  beforeAll(async () => {
    const isolated = await setupIsolatedTestDatabase("connection_profiles")
    pool = isolated.pool
    cleanup = isolated.cleanup
    featureFlagService = new FeatureFlagService(pool)
    eventService = new EventService(pool)
    const storage = createTestStorage()
    avatarService = new AvatarService(storage)
    ends = {
      exporter: new StreamConnectionExportService({ pool, featureFlagService, storage }),
      writer: new StreamConnectionWriteService({ pool, featureFlagService, eventService }),
      avatarService,
    }
    bridge = new DirectBridgeClient(ends)
    pullService = new StreamConnectionPullService({ pool, bridgeClient: bridge, featureFlagService })
    forwardService = new StreamConnectionForwardService({ pool, bridgeClient: bridge, pullService, featureFlagService })
    profileService = new StreamConnectionProfileService({
      pool,
      bridgeClient: bridge,
      featureFlagService,
      avatarService,
    })
  }, 120_000)

  afterAll(async () => cleanup(), 120_000)

  async function seedWorkspace(name: string) {
    const id = workspaceId()
    await WorkspaceRepository.insert(pool, { id, name, slug: `profiles-${id}`, createdBy: userId() })
    const admin = await addTestMember(pool, id, `admin-${id}`, "admin")
    await FeatureFlagOverrideRepository.replaceForSubject(pool, id, "workspace", id, { streamConnections: "on" })
    return { id, name, adminId: admin.id, adminName: admin.name }
  }

  type Workspace = Awaited<ReturnType<typeof seedWorkspace>>

  async function connect(host: Workspace, hostStreamId: string, partner: Workspace) {
    const snapshot: StreamConnectionSnapshot = {
      id: streamConnectionId(),
      revision: 2,
      state: "active",
      hostWorkspaceId: host.id,
      hostWorkspaceName: host.name,
      hostRegion: "local",
      hostStreamId,
      invitedBy: host.adminId,
      partnerWorkspaceId: partner.id,
      partnerWorkspaceName: partner.name,
      partnerRegion: "local",
      partnerVisibility: "private",
      acceptedBy: partner.adminId,
      peerWorkspaceIds: [],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }
    await StreamConnectionRepository.applySnapshots(pool, [snapshot])
    return snapshot
  }

  /** A host channel shared with a partner that has pulled the host admin's first message, and so holds a copy of the admin. */
  async function seedWorld() {
    const host = await seedWorkspace("Profiles host")
    const partner = await seedWorkspace("Profiles partner")
    const channel = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: host.id,
      type: "channel",
      slug: `profiles-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Profiles",
      visibility: "public",
      createdBy: host.adminId,
    })
    const snapshot = await connect(host, channel.id, partner)
    const message = await eventService.createMessage({
      workspaceId: host.id,
      streamId: channel.id,
      authorId: host.adminId,
      authorType: AuthorTypes.USER,
      ...testMessageContent("hello"),
    })
    const partnerRef = { workspaceId: partner.id, connectionId: snapshot.id }
    expect(await pullService.pull(partnerRef)).toBe(true)
    return {
      host,
      partner,
      channel,
      message,
      snapshot,
      partnerRef,
      hostRef: { workspaceId: host.id, connectionId: snapshot.id },
    }
  }

  /** A partner member's message in the copy of `hostStreamId`, sent to the host and pulled back as the app does. */
  async function partnerSays(partnerId: string, hostStreamId: string, authorId: string, text: string) {
    const stream = (await StreamRepository.findById(pool, partnerId, hostStreamId))!
    await forwardService.sendMessage({
      workspaceId: partnerId,
      userId: authorId,
      stream,
      clientMessageId: crypto.randomUUID(),
      contentJson: testContentJson(text),
      attachmentIds: [],
    })
  }

  /** Gives a user a new picture the way the avatar worker leaves one: both files uploaded, then the key set. */
  async function setAvatar(wsId: string, id: string): Promise<string> {
    const token = String(nextToken++)
    const basePath = `avatars/${wsId}/${id}/${token}`
    await avatarService.uploadImages(
      basePath,
      new Map(AVATAR_SIZES.map((size) => [size, Buffer.from(`${token}.${size}`)]))
    )
    await UserRepository.update(pool, wsId, id, { avatarUrl: basePath })
    return token
  }

  async function avatarFiles(wsId: string, id: string, token: string) {
    const files = await Promise.all(
      AVATAR_SIZES.map(async (size) => {
        const file = await fetchAvatarFile(avatarService, {
          workspaceId: wsId,
          userId: id,
          file: `${token}.${size}.webp`,
        })
        return [size, file?.toString() ?? null] as const
      })
    )
    return Object.fromEntries(files)
  }

  const presentFiles = (token: string) => ({ 256: `${token}.256`, 64: `${token}.64` })

  async function copyOf(wsId: string, id: string) {
    const user = await UserRepository.findById(pool, wsId, id)
    return user && { name: user.name, avatarUrl: user.avatarUrl, originWorkspaceId: user.originWorkspaceId }
  }

  async function userUpdates(wsId: string, id: string): Promise<OutboxEvent[]> {
    const { rows } = await pool.query(
      `SELECT id, event_type, payload, created_at FROM outbox
       WHERE event_type = 'workspace_user:updated' AND payload->>'workspaceId' = $1 AND payload->'user'->>'id' = $2
       ORDER BY id`,
      [wsId, id]
    )
    return rows.map((row) => ({
      id: BigInt(row.id),
      eventType: row.event_type,
      payload: row.payload,
      createdAt: row.created_at,
    }))
  }

  async function profileJobs(wsId: string) {
    const { rows } = await pool.query(
      `SELECT payload FROM queue_messages WHERE queue_name = $1 AND workspace_id = $2`,
      [JobQueues.STREAM_CONNECTION_PROFILES, wsId]
    )
    return rows.map((row) => row.payload)
  }

  /** The profile pokes the outbox handler sends for a workspace's updates to one user. */
  async function profilePokes(wsId: string, id: string) {
    const recorder = new RecordingBridgeClient()
    await new TestPokeHandler(pool, recorder).run(await userUpdates(wsId, id))
    return recorder.profilePokes
  }

  test("should name and picture a partner's copy of a host member as the host has them when the copy refreshes", async () => {
    const world = await seedWorld()
    const queued = await profileJobs(world.partner.id)
    await UserRepository.update(pool, world.host.id, world.host.adminId, { name: "Ada Host" })
    const token = await setAvatar(world.host.id, world.host.adminId)

    await profileService.refresh(world.partnerRef)

    const copiedAvatar = `avatars/${world.partner.id}/${world.host.adminId}/${token}`
    expect({
      queued,
      copy: await copyOf(world.partner.id, world.host.adminId),
      files: await avatarFiles(world.partner.id, world.host.adminId, token),
      updates: (await userUpdates(world.partner.id, world.host.adminId)).map((event) => event.payload),
    }).toEqual({
      queued: [world.partnerRef],
      copy: { name: "Ada Host", avatarUrl: copiedAvatar, originWorkspaceId: world.host.id },
      files: presentFiles(token),
      updates: [
        {
          workspaceId: world.partner.id,
          user: expect.objectContaining({ id: world.host.adminId, name: "Ada Host", avatarUrl: copiedAvatar }),
        },
      ],
    })
  })

  test("should drop a copy's old picture files when the remote member replaces or removes theirs", async () => {
    const world = await seedWorld()
    const first = await setAvatar(world.host.id, world.host.adminId)
    await profileService.refresh(world.partnerRef)
    const second = await setAvatar(world.host.id, world.host.adminId)
    await profileService.refresh(world.partnerRef)
    const replaced = {
      avatarUrl: (await copyOf(world.partner.id, world.host.adminId))?.avatarUrl,
      first: await avatarFiles(world.partner.id, world.host.adminId, first),
      second: await avatarFiles(world.partner.id, world.host.adminId, second),
    }

    await UserRepository.update(pool, world.host.id, world.host.adminId, { avatarUrl: null })
    await profileService.refresh(world.partnerRef)

    expect({
      replaced,
      removed: {
        avatarUrl: (await copyOf(world.partner.id, world.host.adminId))?.avatarUrl,
        second: await avatarFiles(world.partner.id, world.host.adminId, second),
      },
    }).toEqual({
      replaced: {
        avatarUrl: `avatars/${world.partner.id}/${world.host.adminId}/${second}`,
        first: { 256: null, 64: null },
        second: presentFiles(second),
      },
      removed: { avatarUrl: null, second: { 256: null, 64: null } },
    })
  })

  test("should rename a copy and keep its picture when the remote's picture files are gone", async () => {
    const world = await seedWorld()
    const kept = await setAvatar(world.host.id, world.host.adminId)
    await profileService.refresh(world.partnerRef)
    await UserRepository.update(pool, world.host.id, world.host.adminId, {
      name: "Ada Moved",
      avatarUrl: `avatars/${world.host.id}/${world.host.adminId}/${nextToken++}`,
    })

    await profileService.refresh(world.partnerRef)

    expect(await copyOf(world.partner.id, world.host.adminId)).toEqual({
      name: "Ada Moved",
      avatarUrl: `avatars/${world.partner.id}/${world.host.adminId}/${kept}`,
      originWorkspaceId: world.host.id,
    })
  })

  test("should keep the host's copy of a partner member current when the host refreshes", async () => {
    const world = await seedWorld()
    const pat = await addTestMember(pool, world.partner.id, `pat-${world.partner.id}`)
    await partnerSays(world.partner.id, world.channel.id, pat.id, "from the partner")
    const queued = await profileJobs(world.host.id)
    await UserRepository.update(pool, world.partner.id, pat.id, { name: "Pat Partner" })
    const token = await setAvatar(world.partner.id, pat.id)

    await profileService.refresh(world.hostRef)

    expect({ queued, copy: await copyOf(world.host.id, pat.id) }).toEqual({
      queued: [world.hostRef],
      copy: {
        name: "Pat Partner",
        avatarUrl: `avatars/${world.host.id}/${pat.id}/${token}`,
        originWorkspaceId: world.partner.id,
      },
    })
  })

  test("should relay a partner member's new name to another partner through the host without poking it back home", async () => {
    const world = await seedWorld()
    const other = await seedWorkspace("Profiles second partner")
    const otherRef = { workspaceId: other.id, connectionId: (await connect(world.host, world.channel.id, other)).id }
    const pat = await addTestMember(pool, world.partner.id, `pat-${world.partner.id}`)
    await partnerSays(world.partner.id, world.channel.id, pat.id, "hello both")
    expect(await pullService.pull(otherRef)).toBe(true)
    await UserRepository.update(pool, world.partner.id, pat.id, { name: "Pat Relayed" })

    await profileService.refresh(world.hostRef)
    await profileService.refresh(otherRef)

    expect({
      hostPokes: await profilePokes(world.host.id, pat.id),
      otherPokes: await profilePokes(other.id, pat.id),
      copy: await copyOf(other.id, pat.id),
    }).toEqual({
      hostPokes: [{ workspaceId: other.id, connectionId: otherRef.connectionId, callerWorkspaceId: world.host.id }],
      otherPokes: [],
      copy: { name: "Pat Relayed", avatarUrl: null, originWorkspaceId: world.host.id },
    })
  })

  test("should answer only for members who wrote or reacted in the shared channel, never for the caller's own", async () => {
    const world = await seedWorld()
    const reactor = await addTestMember(pool, world.host.id, `reactor-${world.host.id}`)
    const bystander = await addTestMember(pool, world.host.id, `bystander-${world.host.id}`)
    await eventService.addReactionInternal({
      workspaceId: world.host.id,
      messageId: world.message.id,
      streamId: world.channel.id,
      emoji: "👍",
      userId: reactor.id,
    })
    const pat = await addTestMember(pool, world.partner.id, `pat-${world.partner.id}`)
    await partnerSays(world.partner.id, world.channel.id, pat.id, "mine")

    const answer = await ends.exporter.getProfiles({
      workspaceId: world.host.id,
      connectionId: world.snapshot.id,
      callerWorkspaceId: world.partner.id,
      userIds: [world.host.adminId, reactor.id, bystander.id, pat.id, "usr_missing"],
    })

    expect([...answer.users].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: world.host.adminId, name: world.host.adminName, avatar: null },
        { id: reactor.id, name: reactor.name, avatar: null },
      ].sort((a, b) => a.id.localeCompare(b.id))
    )
  })

  test("should leave copies untouched when the connection is revoked while a refresh reads", async () => {
    const world = await seedWorld()
    await UserRepository.update(pool, world.host.id, world.host.adminId, { name: "Ada Late" })
    const revoking = new InterruptedBridgeClient(ends, () =>
      StreamConnectionRepository.applySnapshots(pool, [{ ...world.snapshot, revision: 3, state: "revoked" }])
    )

    await new StreamConnectionProfileService({
      pool,
      bridgeClient: revoking,
      featureFlagService,
      avatarService,
    }).refresh(world.partnerRef)

    expect({
      copy: await copyOf(world.partner.id, world.host.adminId),
      updates: await userUpdates(world.partner.id, world.host.adminId),
    }).toEqual({
      copy: { name: world.host.adminName, avatarUrl: null, originWorkspaceId: world.host.id },
      updates: [],
    })
  })
})
