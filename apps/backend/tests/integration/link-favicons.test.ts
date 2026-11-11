import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { AuthorTypes, StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, seedCompletedLinkPreview, setupTestDatabase } from "./setup"
import { LinkFaviconRepository, LinkFaviconService } from "../../src/features/link-previews"
import { EventService, MessageRepository } from "../../src/features/messaging"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { streamId, workspaceId } from "../../src/lib/id"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 1])
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 9])

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

  function privateChannel(ws: string, createdBy: string) {
    return StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.CHANNEL,
      slug: `c-${streamId().slice(-8).toLowerCase()}`,
      visibility: Visibilities.PRIVATE,
      createdBy,
    })
  }

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

    const shared = await privateChannel(ws, owner)
    await StreamMemberRepository.insertMany(pool, ws, shared.id, [owner, reader])
    const ownersOnly = await privateChannel(ws, owner)
    await StreamMemberRepository.insertMany(pool, ws, ownersOnly.id, [owner])
    const thread = await StreamRepository.insert(pool, {
      id: streamId(),
      workspaceId: ws,
      type: StreamTypes.THREAD,
      displayName: "A thread",
      parentStreamId: shared.id,
      rootStreamId: shared.id,
      createdBy: owner,
    })
    await StreamMemberRepository.insertMany(pool, ws, thread.id, [owner])

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
