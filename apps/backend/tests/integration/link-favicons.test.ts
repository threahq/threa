import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, seedCompletedLinkPreview, setupTestDatabase } from "./setup"
import { LinkFaviconRepository, LinkFaviconService } from "../../src/features/link-previews"
import { enqueueDocLinkFaviconEnsures } from "../../src/features/link-previews/favicon-ensure"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { DocReferenceTypes, DocRepository } from "../../src/features/docs"
import { JobQueues } from "../../src/lib/queue"
import { streamId, workspaceId } from "../../src/lib/id"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 1])
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 9])

async function privateChannel(pool: Pool, ws: string, createdBy: string, members: string[]) {
  const stream = await StreamRepository.insert(pool, {
    id: streamId(),
    workspaceId: ws,
    type: StreamTypes.CHANNEL,
    slug: `c-${streamId().slice(-8).toLowerCase()}`,
    visibility: Visibilities.PRIVATE,
    createdBy,
  })
  await StreamMemberRepository.insertMany(pool, ws, stream.id, members)
  return stream
}

/** A thread under `parentId` whose only member is its creator: access comes from the root, never the thread. */
async function threadIn(pool: Pool, ws: string, parentId: string, createdBy: string) {
  const thread = await StreamRepository.insert(pool, {
    id: streamId(),
    workspaceId: ws,
    type: StreamTypes.THREAD,
    displayName: "A thread",
    parentStreamId: parentId,
    rootStreamId: parentId,
    createdBy,
  })
  await StreamMemberRepository.insertMany(pool, ws, thread.id, [createdBy])
  return thread
}

describe("LinkFaviconRepository", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should round-trip bytes and content type when an icon is stored", async () => {
    const ws = workspaceId()
    const expiresAt = new Date(Date.now() + 86_400_000)
    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: ws,
      host: "example.com",
      contentType: "image/png",
      bytes: PNG,
      expiresAt,
    })

    const found = await LinkFaviconRepository.find(pool, ws, "example.com")
    expect({ ...found, bytes: Array.from(found!.bytes!), fetchedAt: undefined }).toEqual({
      workspaceId: ws,
      host: "example.com",
      contentType: "image/png",
      bytes: Array.from(PNG),
      fetchedAt: undefined,
      expiresAt,
    })
  })

  test("should keep the stored bytes and move expires_at when a miss is recorded over an icon", async () => {
    const ws = workspaceId()
    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: ws,
      host: "example.com",
      contentType: "image/x-icon",
      bytes: ICO,
      expiresAt: new Date(Date.now() - 1000),
    })
    const retryAt = new Date(Date.now() + 3_600_000)
    await LinkFaviconRepository.recordMiss(pool, { workspaceId: ws, host: "example.com", expiresAt: retryAt })

    const found = await LinkFaviconRepository.find(pool, ws, "example.com")
    expect({ contentType: found!.contentType, bytes: Array.from(found!.bytes!), expiresAt: found!.expiresAt }).toEqual({
      contentType: "image/x-icon",
      bytes: Array.from(ICO),
      expiresAt: retryAt,
    })
  })

  test("should create an icon-less row when a miss is recorded with no prior row", async () => {
    const ws = workspaceId()
    const retryAt = new Date(Date.now() + 3_600_000)
    await LinkFaviconRepository.recordMiss(pool, { workspaceId: ws, host: "nothing.example", expiresAt: retryAt })

    const found = await LinkFaviconRepository.find(pool, ws, "nothing.example")
    expect({ contentType: found!.contentType, bytes: found!.bytes, expiresAt: found!.expiresAt }).toEqual({
      contentType: null,
      bytes: null,
      expiresAt: retryAt,
    })
  })

  test("should not return another workspace's icon when the host matches", async () => {
    const owner = workspaceId()
    const other = workspaceId()
    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: owner,
      host: "shared.example",
      contentType: "image/png",
      bytes: PNG,
      expiresAt: new Date(Date.now() + 86_400_000),
    })

    expect({
      owner: (await LinkFaviconRepository.find(pool, owner, "shared.example"))?.workspaceId,
      other: await LinkFaviconRepository.find(pool, other, "shared.example"),
    }).toEqual({ owner, other: null })
  })
})

describe("LinkFaviconService.getIcon access", () => {
  let pool: Pool
  let eventService: EventService
  let service: LinkFaviconService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    eventService = new EventService(pool)
    service = new LinkFaviconService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  async function link(ws: string, sid: string, authorId: string, url: string) {
    const message = await eventService.createMessage({
      workspaceId: ws,
      streamId: sid,
      authorId,
      authorType: AuthorTypes.USER,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: url }] }] },
      contentMarkdown: url,
    })
    await seedCompletedLinkPreview(pool, { workspaceId: ws, messageId: message.id, url, title: "A page" })
    return message
  }

  test("should serve an icon only for hosts linked in messages the user can read", async () => {
    const ws = workspaceId()
    const owner = (await addTestMember(pool, ws, `owner_${ws}`)).id
    const reader = (await addTestMember(pool, ws, `reader_${ws}`)).id
    await WorkspaceRepository.insert(pool, { id: ws, name: "Icons WS", slug: `icons-${ws}`, createdBy: owner })

    const shared = await privateChannel(pool, ws, owner, [owner, reader])
    const ownersOnly = await privateChannel(pool, ws, owner, [owner])
    const thread = await threadIn(pool, ws, shared.id, owner)

    await link(ws, shared.id, owner, "https://channel.example/page")
    await link(ws, shared.id, owner, "https://Shop.Example:8443/cart?utm_source=x")
    await link(ws, shared.id, owner, "https://myxhost.example/page")
    await link(ws, shared.id, owner, "https://prefix.example.evil.test/page")
    await link(ws, thread.id, owner, "https://thread.example/")
    await link(ws, ownersOnly.id, owner, "https://secret.example/page")
    const removed = await link(ws, shared.id, owner, "https://deleted.example/page")
    await MessageRepository.softDelete(pool, ws, removed.id)

    const hosts = [
      "channel.example",
      "shop.example:8443",
      "thread.example",
      "secret.example",
      "deleted.example",
      "my_host.example",
      "prefix.example",
      "never-linked.example",
    ]
    for (const host of hosts.slice(0, -1)) {
      await LinkFaviconRepository.storeIcon(pool, {
        workspaceId: ws,
        host,
        contentType: "image/png",
        bytes: PNG,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    }

    async function served(userId: string) {
      const entries = await Promise.all(
        hosts.map(async (host) => [host, (await service.getIcon(ws, userId, host)) !== null] as const)
      )
      return Object.fromEntries(entries)
    }

    expect({ reader: await served(reader), owner: await served(owner) }).toEqual({
      reader: {
        "channel.example": true,
        "shop.example:8443": true,
        "thread.example": true,
        "secret.example": false,
        "deleted.example": false,
        "my_host.example": false,
        "prefix.example": false,
        "never-linked.example": false,
      },
      owner: {
        "channel.example": true,
        "shop.example:8443": true,
        "thread.example": true,
        "secret.example": true,
        "deleted.example": false,
        "my_host.example": false,
        "prefix.example": false,
        "never-linked.example": false,
      },
    })
  })
})

describe("LinkFaviconRepository doc links", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function seedWorkspace() {
    const ws = workspaceId()
    const owner = (await addTestMember(pool, ws, `owner_${ws}`)).id
    const reader = (await addTestMember(pool, ws, `reader_${ws}`)).id
    await WorkspaceRepository.insert(pool, { id: ws, name: "Doc Icons WS", slug: `doc-icons-${ws}`, createdBy: owner })
    return { ws, owner, reader }
  }

  async function createDoc(ws: string, host: { id: string; rootStreamId: string | null }, createdBy: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.DOC,
      displayName: "A doc",
      parentStreamId: host.id,
      rootStreamId: host.rootStreamId ?? host.id,
      createdBy,
    })
  }

  async function linkOrigins(ws: string, docId: string, origins: string[]) {
    await DocRepository.replaceReferences(
      pool,
      ws,
      docId,
      origins.map((refId, i) => ({ blockId: `blk_${i}`, refType: DocReferenceTypes.LINK_ORIGIN, refId }))
    )
  }

  test("should treat a host as readable only when it is linked in a doc the user can read", async () => {
    const { ws, owner, reader } = await seedWorkspace()
    const shared = await privateChannel(pool, ws, owner, [owner, reader])
    const ownersOnly = await privateChannel(pool, ws, owner, [owner])
    const sharedDoc = await createDoc(ws, shared, owner)
    const ownersDoc = await createDoc(ws, ownersOnly, owner)
    const embedDoc = await createDoc(ws, shared, owner)
    const sharedThreadDoc = await createDoc(ws, await threadIn(pool, ws, shared.id, owner), owner)
    const ownersThreadDoc = await createDoc(ws, await threadIn(pool, ws, ownersOnly.id, owner), owner)
    await linkOrigins(ws, sharedDoc.id, ["https://hosted.example", "http://dev.example:8080"])
    await linkOrigins(ws, ownersDoc.id, ["https://secret.example"])
    await linkOrigins(ws, sharedThreadDoc.id, ["https://thread-doc.example"])
    await linkOrigins(ws, ownersThreadDoc.id, ["https://secret-thread-doc.example"])
    await DocRepository.replaceReferences(pool, ws, embedDoc.id, [
      { blockId: "blk_0", refType: DocReferenceTypes.DOC, refId: "https://embed-only.example" },
    ])
    const otherWorkspace = await seedWorkspace()
    const otherChannel = await privateChannel(pool, otherWorkspace.ws, otherWorkspace.owner, [otherWorkspace.owner])
    const otherDoc = await createDoc(otherWorkspace.ws, otherChannel, otherWorkspace.owner)
    await linkOrigins(otherWorkspace.ws, otherDoc.id, ["https://other-workspace.example"])

    const hosts = [
      "hosted.example",
      "dev.example:8080",
      "thread-doc.example",
      "secret.example",
      "secret-thread-doc.example",
      "embed-only.example",
      "dev.example",
      "other-workspace.example",
    ]
    async function readable(userId: string) {
      const entries = await Promise.all(
        hosts.map(
          async (host) =>
            [host, await LinkFaviconRepository.isHostLinkedInReadableStream(pool, ws, userId, host)] as const
        )
      )
      return Object.fromEntries(entries)
    }

    expect({ reader: await readable(reader), owner: await readable(owner) }).toEqual({
      reader: {
        "hosted.example": true,
        "dev.example:8080": true,
        "thread-doc.example": true,
        "secret.example": false,
        "secret-thread-doc.example": false,
        "embed-only.example": false,
        "dev.example": false,
        "other-workspace.example": false,
      },
      owner: {
        "hosted.example": true,
        "dev.example:8080": true,
        "thread-doc.example": true,
        "secret.example": true,
        "secret-thread-doc.example": true,
        "embed-only.example": false,
        "dev.example": false,
        "other-workspace.example": false,
      },
    })
  })

  test("should list each host on the given blocks that has no unexpired row, preferring its https origin", async () => {
    const { ws, owner } = await seedWorkspace()
    const doc = await createDoc(ws, await privateChannel(pool, ws, owner, [owner]), owner)
    const origins = [
      "https://fresh-icon.example",
      "https://fresh-miss.example",
      "https://expired.example",
      "https://absent.example:8443",
      "http://both-schemes.example",
      "https://both-schemes.example",
    ]
    await DocRepository.replaceReferences(pool, ws, doc.id, [
      ...origins.map((refId) => ({ blockId: "blk_a", refType: DocReferenceTypes.LINK_ORIGIN, refId })),
      { blockId: "blk_b", refType: DocReferenceTypes.LINK_ORIGIN, refId: "https://absent.example:8443" },
      { blockId: "blk_c", refType: DocReferenceTypes.LINK_ORIGIN, refId: "https://untouched.example" },
      { blockId: "blk_a", refType: DocReferenceTypes.DOC, refId: "stream_other" },
    ])
    const future = new Date(Date.now() + 3_600_000)
    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: ws,
      host: "fresh-icon.example",
      contentType: "image/png",
      bytes: PNG,
      expiresAt: future,
    })
    await LinkFaviconRepository.recordMiss(pool, { workspaceId: ws, host: "fresh-miss.example", expiresAt: future })
    await LinkFaviconRepository.recordMiss(pool, {
      workspaceId: ws,
      host: "expired.example",
      expiresAt: new Date(Date.now() - 1000),
    })
    await LinkFaviconRepository.storeIcon(pool, {
      workspaceId: workspaceId(),
      host: "absent.example:8443",
      contentType: "image/png",
      bytes: PNG,
      expiresAt: future,
    })

    expect(await LinkFaviconRepository.listUncachedDocLinkOrigins(pool, ws, doc.id, ["blk_a", "blk_b"])).toEqual([
      { host: "absent.example:8443", origin: "https://absent.example:8443" },
      { host: "both-schemes.example", origin: "https://both-schemes.example" },
      { host: "expired.example", origin: "https://expired.example" },
    ])
  })

  test("should leave one ensure job per host when the same doc update is enqueued twice", async () => {
    const { ws, owner } = await seedWorkspace()
    const doc = await createDoc(ws, await privateChannel(pool, ws, owner, [owner]), owner)
    await linkOrigins(ws, doc.id, ["https://one.example", "http://two.example:8080"])
    const update = { workspaceId: ws, docId: doc.id, blockIds: ["blk_0", "blk_1"] }

    await enqueueDocLinkFaviconEnsures(pool, update)
    await enqueueDocLinkFaviconEnsures(pool, update)

    const jobs = await pool.query<{ page_url: string }>(
      "SELECT payload->>'pageUrl' AS page_url FROM queue_messages WHERE workspace_id = $1 AND queue_name = $2",
      [ws, JobQueues.LINK_FAVICON_ENSURE]
    )
    expect(jobs.rows.map((row) => row.page_url).sort()).toEqual(["http://two.example:8080/", "https://one.example/"])
  })
})
