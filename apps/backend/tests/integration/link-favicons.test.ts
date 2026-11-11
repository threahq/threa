import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { setupTestDatabase } from "./setup"
import { LinkFaviconRepository } from "../../src/features/link-previews"
import { workspaceId } from "../../src/lib/id"

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
