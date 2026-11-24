import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"
import type { Pool } from "pg"
import { AttachmentSafetyStatuses, StreamTypes } from "@threahq/types"
import { addTestMember, createTestStorage, setupTestDatabase, withTransaction } from "./setup"
import {
  AttachmentRepository,
  AttachmentService,
  VideoStoryboardService,
  createAttachmentHandlers,
  resolveMediaTools,
  type MediaTools,
} from "../../src/features/attachments"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import type { StorageProvider } from "../../src/lib/storage/s3-client"
import { attachmentId, streamId, workspaceId } from "../../src/lib/id"

interface Answer {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** Seeded so the "not video" input cannot occasionally probe as a decodable stream. */
function noise(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  let state = 0x2545f491
  for (let i = 0; i < length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[i] = state & 0xff
  }
  return bytes
}

describe("VideoStoryboardService", () => {
  let pool: Pool
  let storage: StorageProvider
  let tools: MediaTools
  let service: VideoStoryboardService
  let attachmentService: AttachmentService
  let handlers: ReturnType<typeof createAttachmentHandlers>
  let scratch: string
  const ws = workspaceId()
  const stream = streamId()
  let ownerId: string
  let outsiderId: string

  async function exec(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`${cmd[0]} failed: ${stderr}`)
    return stdout.trim()
  }

  async function testsrc(name: string, seconds: number, size: string, audioSeconds?: number): Promise<Buffer> {
    const path = join(scratch, name)
    const audio = audioSeconds
      ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${audioSeconds}`, "-c:a", "aac"]
      : []
    await exec([
      tools.ffmpegPath,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${seconds}:size=${size}:rate=10`,
      ...audio,
      "-c:v",
      "mpeg4",
      "-pix_fmt",
      "yuv420p",
      path,
    ])
    return readFile(path)
  }

  async function seed(
    filename: string,
    mimeType: string,
    bytes: Buffer,
    options: { e2eOnly?: boolean } = {}
  ): Promise<string> {
    const id = attachmentId()
    const storagePath = `${ws}/${id}/${filename}`
    await storage.putObject(storagePath, bytes, mimeType)
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: ws,
      streamId: stream,
      uploadedBy: ownerId,
      filename,
      mimeType,
      sizeBytes: bytes.length,
      storagePath,
      safetyStatus: "clean",
      e2eOnly: options.e2eOnly,
    })
    return id
  }

  async function call(
    handler: "ensureStoryboard" | "getStoryboardSprite" | "getContent",
    caller: string,
    id: string
  ): Promise<Answer> {
    const answer: Answer = { status: 200, headers: {}, body: undefined }
    const sink = new PassThrough()
    const chunks: Buffer[] = []
    sink.on("data", (chunk: Buffer) => chunks.push(chunk))
    const done = new Promise<void>((resolve) => sink.on("end", resolve))
    let ended = false
    const res = Object.assign(sink, {
      locals: {},
      headersSent: false,
      status(code: number) {
        answer.status = code
        return res
      },
      set(name: string, value: string) {
        answer.headers[name.toLowerCase()] = value
        return res
      },
      json(body: unknown) {
        answer.body = body
        ended = true
        return res
      },
    }) as unknown as ExpressResponse
    const req = { user: { id: caller }, workspaceId: ws, params: { attachmentId: id }, query: {}, headers: {} }
    await handlers[handler](req as unknown as ExpressRequest, res)
    if (!ended && answer.status === 200) {
      await done
      answer.body = Buffer.concat(chunks)
    }
    return answer
  }

  async function probeSize(bytes: Buffer): Promise<string> {
    const path = join(scratch, `${crypto.randomUUID()}.jpg`)
    await writeFile(path, bytes)
    return exec([tools.ffprobePath, "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path])
  }

  async function storyboardRows(id: string) {
    const rows = await pool.query(
      `SELECT status FROM video_storyboards WHERE workspace_id = $1 AND attachment_id = $2`,
      [ws, id]
    )
    const jobs = await pool.query(
      `SELECT queue_name, payload FROM queue_messages WHERE workspace_id = $1 AND payload->>'attachmentId' = $2`,
      [ws, id]
    )
    return { rows: rows.rows, jobs: jobs.rows }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    storage = createTestStorage()
    const resolved = resolveMediaTools()
    if (!resolved) throw new Error("ffmpeg and ffprobe must be on PATH for storyboard integration tests")
    tools = resolved
    service = new VideoStoryboardService({ pool, storage, tools })
    attachmentService = new AttachmentService(pool, storage, {
      scan: async () => ({ status: AttachmentSafetyStatuses.CLEAN }),
    } as never)
    handlers = createAttachmentHandlers({
      attachmentService,
      videoStoryboardService: service,
      streamService: new StreamService(pool),
      storage,
      pool,
    })
    ownerId = (await addTestMember(pool, ws, `owner-${crypto.randomUUID()}`)).id
    outsiderId = (await addTestMember(pool, ws, `outsider-${crypto.randomUUID()}`)).id
    await withTransaction(pool, async (tx) => {
      await StreamRepository.insert(tx, {
        id: stream,
        workspaceId: ws,
        type: StreamTypes.SCRATCHPAD,
        displayName: "Clips",
        displayNameSource: "explicit",
        createdBy: ownerId,
      })
      await StreamMemberRepository.insert(tx, ws, stream, ownerId)
    })
    scratch = await mkdtemp(join(tmpdir(), "video-storyboard-test-"))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
    await pool.end()
  })

  test("should queue on the first ask, then serve a ready 10x3 sprite of 240x180 tiles", async () => {
    const id = await seed("clip.mp4", "video/mp4", await testsrc("clip.mp4", 12, "320x240"))

    const first = await call("ensureStoryboard", ownerId, id)
    await service.process(ws, id)
    const second = await call("ensureStoryboard", ownerId, id)
    const sprite = await storage.getObject(`${ws}/${id}/storyboard.jpg`)

    expect({ first: first.body, second: second.body, spriteSize: await probeSize(sprite) }).toEqual({
      first: { status: "pending" },
      second: {
        status: "ready",
        columns: 10,
        rows: 3,
        tileCount: 24,
        intervalMs: 500,
        tileWidth: 240,
        tileHeight: 180,
      },
      spriteSize: "2400x540",
    })
  })

  test("should give a portrait video tiles taller than wide", async () => {
    const id = await seed("portrait.mp4", "video/mp4", await testsrc("portrait.mp4", 2, "180x320"))
    await call("ensureStoryboard", ownerId, id)

    await service.process(ws, id)

    const ready = (await call("ensureStoryboard", ownerId, id)).body as { tileWidth: number; tileHeight: number }
    expect({ tallerThanWide: ready.tileHeight > ready.tileWidth, tileHeight: ready.tileHeight }).toEqual({
      tallerThanWide: true,
      tileHeight: 180,
    })
  })

  test("should apply a rotation tag so a rotated landscape recording gets portrait tiles", async () => {
    await testsrc("unrotated.mp4", 3, "320x240")
    const rotatedPath = join(scratch, "rotated.mp4")
    await exec([
      tools.ffmpegPath,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-display_rotation",
      "90",
      "-i",
      join(scratch, "unrotated.mp4"),
      "-c",
      "copy",
      rotatedPath,
    ])
    const id = await seed("rotated.mp4", "video/mp4", await readFile(rotatedPath))
    await call("ensureStoryboard", ownerId, id)

    await service.process(ws, id)

    const ready = await call("ensureStoryboard", ownerId, id)
    const sprite = await storage.getObject(`${ws}/${id}/storyboard.jpg`)
    expect({ storyboard: ready.body, spriteSize: await probeSize(sprite) }).toEqual({
      storyboard: {
        status: "ready",
        columns: 6,
        rows: 1,
        tileCount: 6,
        intervalMs: 500,
        tileWidth: 136,
        tileHeight: 180,
      },
      spriteSize: "816x180",
    })
  })

  test("should repeat the last frame for tiles after the picture ends when the audio runs longer", async () => {
    const id = await seed("tail.mp4", "video/mp4", await testsrc("tail.mp4", 4, "320x240", 6))
    await call("ensureStoryboard", ownerId, id)

    await service.process(ws, id)

    const sprite = await storage.getObject(`${ws}/${id}/storyboard.jpg`)
    expect({
      answer: (await call("ensureStoryboard", ownerId, id)).body,
      spriteSize: await probeSize(sprite),
    }).toEqual({
      answer: {
        status: "ready",
        columns: 10,
        rows: 2,
        tileWidth: 240,
        tileHeight: 180,
        tileCount: 12,
        intervalMs: 500,
      },
      spriteSize: "2400x360",
    })
  })

  test("should remove the storyboard row when its attachment is deleted", async () => {
    const id = await seed("gone.mp4", "video/mp4", await testsrc("gone.mp4", 1, "320x240"))
    await call("ensureStoryboard", ownerId, id)

    await attachmentService.delete(ws, id)

    expect((await storyboardRows(id)).rows).toEqual([])
  })

  test("should leave one row and one queued job after two concurrent first asks", async () => {
    const id = await seed("race.mp4", "video/mp4", await testsrc("race.mp4", 1, "320x240"))

    const answers = await Promise.all([call("ensureStoryboard", ownerId, id), call("ensureStoryboard", ownerId, id)])

    expect({ answers: answers.map((a) => a.body), ...(await storyboardRows(id)) }).toEqual({
      answers: [{ status: "pending" }, { status: "pending" }],
      rows: [{ status: "pending" }],
      jobs: [{ queue_name: "video.storyboard", payload: { workspaceId: ws, attachmentId: id } }],
    })
  })

  test("should end random bytes named .mp4 unavailable without throwing", async () => {
    const id = await seed("noise.mp4", "video/mp4", noise(4096))
    await call("ensureStoryboard", ownerId, id)

    await service.process(ws, id)

    expect({
      answer: (await call("ensureStoryboard", ownerId, id)).body,
      rows: (await storyboardRows(id)).rows,
    }).toEqual({ answer: { status: "unavailable" }, rows: [{ status: "failed" }] })
  })

  test("should answer unavailable without a row for a non-video and for an e2e-only video", async () => {
    const pdf = await seed("notes.pdf", "application/pdf", Buffer.from("%PDF-1.4 synthetic"))
    const sealed = await seed("sealed.mp4", "video/mp4", noise(1024), { e2eOnly: true })

    const answers = [
      (await call("ensureStoryboard", ownerId, pdf)).body,
      (await call("ensureStoryboard", ownerId, sealed)).body,
    ]

    expect({ answers, pdf: await storyboardRows(pdf), sealed: await storyboardRows(sealed) }).toEqual({
      answers: [{ status: "unavailable" }, { status: "unavailable" }],
      pdf: { rows: [], jobs: [] },
      sealed: { rows: [], jobs: [] },
    })
  })

  test("should refuse an outsider like /content and serve the sprite immutable only once ready", async () => {
    const id = await seed("access.mp4", "video/mp4", await testsrc("access.mp4", 1, "320x240"))

    const content = await call("getContent", outsiderId, id)
    const refusals = {
      ensure: await call("ensureStoryboard", outsiderId, id),
      sprite: await call("getStoryboardSprite", outsiderId, id),
    }
    const afterRefusal = await storyboardRows(id)
    await call("ensureStoryboard", ownerId, id)
    const beforeJob = await call("getStoryboardSprite", ownerId, id)
    await service.process(ws, id)
    const served = await call("getStoryboardSprite", ownerId, id)

    const refusal = { status: content.status, body: content.body }
    expect({
      ensure: { status: refusals.ensure.status, body: refusals.ensure.body },
      sprite: { status: refusals.sprite.status, body: refusals.sprite.body },
      afterRefusal,
      beforeJob: { status: beforeJob.status, body: beforeJob.body },
      served: {
        status: served.status,
        contentType: served.headers["content-type"],
        cacheControl: served.headers["cache-control"],
        hasEtag: Boolean(served.headers.etag),
        size: await probeSize(served.body as Buffer),
      },
    }).toEqual({
      ensure: refusal,
      sprite: refusal,
      afterRefusal: { rows: [], jobs: [] },
      beforeJob: { status: 404, body: { error: "Storyboard not found" } },
      served: {
        status: 200,
        contentType: "image/jpeg",
        cacheControl: "private, max-age=31536000, immutable",
        hasEtag: true,
        size: "480x180",
      },
    })
    expect(refusal).toEqual({ status: 403, body: { error: "Access denied" } })
  })

  test("should leave a ready storyboard untouched when its job runs again", async () => {
    const id = await seed("again.mp4", "video/mp4", await testsrc("again.mp4", 1, "320x240"))
    await call("ensureStoryboard", ownerId, id)
    await service.process(ws, id)
    const read = () =>
      pool.query(`SELECT * FROM video_storyboards WHERE workspace_id = $1 AND attachment_id = $2`, [ws, id])
    const before = (await read()).rows

    await service.process(ws, id)

    expect((await read()).rows).toEqual(before)
  })
})
