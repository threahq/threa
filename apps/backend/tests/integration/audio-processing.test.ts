import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Pool } from "pg"
import { ProcessingStatuses } from "@threahq/types"
import { createTestStorage, setupTestDatabase } from "./setup"
import { AttachmentRepository, AudioProcessingService, resolveAudioTools } from "../../src/features/attachments"
import type { AudioTools } from "../../src/features/attachments"
import type { StorageProvider } from "../../src/lib/storage/s3-client"
import { attachmentId, userId, workspaceId } from "../../src/lib/id"

const SOURCE_SECONDS = 3

/** Seeded so the "not audio" input cannot occasionally probe as a decodable stream. */
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

describe("AudioProcessingService", () => {
  let pool: Pool
  let storage: StorageProvider
  let tools: AudioTools
  let service: AudioProcessingService
  let scratch: string
  const ws = workspaceId()

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

  async function sine(name: string, codecArgs: string[]): Promise<Buffer> {
    const path = join(scratch, name)
    await exec([
      tools.ffmpegPath,
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${SOURCE_SECONDS}`,
      ...codecArgs,
      path,
    ])
    return readFile(path)
  }

  async function seed(filename: string, mimeType: string, bytes: Buffer): Promise<string> {
    const id = attachmentId()
    const storagePath = `${ws}/${id}/${filename}`
    await storage.putObject(storagePath, bytes, mimeType)
    await AttachmentRepository.insert(pool, {
      id,
      workspaceId: ws,
      uploadedBy: userId(),
      filename,
      mimeType,
      sizeBytes: bytes.length,
      storagePath,
      safetyStatus: "clean",
    })
    return id
  }

  async function observe(id: string) {
    const row = await pool.query(
      `SELECT processing_status, normalized_audio_storage_path, duration_ms, waveform FROM attachments WHERE id = $1`,
      [id]
    )
    const events = await pool.query(
      `SELECT event_type, payload FROM outbox WHERE payload->>'attachmentId' = $1 ORDER BY id`,
      [id]
    )
    return { row: row.rows[0], events: events.rows }
  }

  function waveformStats(waveform: string) {
    const bytes = Buffer.from(waveform, "base64")
    return { length: bytes.length, max: Math.max(...bytes) }
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    storage = createTestStorage()
    const resolved = resolveAudioTools()
    if (!resolved) throw new Error("ffmpeg and ffprobe must be on PATH for audio integration tests")
    tools = resolved
    service = new AudioProcessingService({ pool, storage, tools })
    scratch = await mkdtemp(join(tmpdir(), "audio-processing-test-"))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
    await pool.end()
  })

  test("should transcode a WAV to AAC, store duration and waveform, and emit the result", async () => {
    const id = await seed("tone.wav", "audio/wav", await sine("tone.wav", ["-ac", "2"]))

    await service.process(ws, id)

    const { row, events } = await observe(id)
    const normalizedPath = `${ws}/derived/${id}/normalized.m4a`
    const normalizedFile = join(scratch, `${id}.m4a`)
    await writeFile(normalizedFile, await storage.getObject(normalizedPath))
    const codec = await exec([
      tools.ffprobePath,
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,channels",
      "-of",
      "csv=p=0",
      normalizedFile,
    ])

    expect({
      status: row.processing_status,
      path: row.normalized_audio_storage_path,
      durationOff: Math.abs(row.duration_ms - SOURCE_SECONDS * 1000) <= 100,
      waveform: waveformStats(row.waveform),
      codec,
      events,
    }).toEqual({
      status: ProcessingStatuses.COMPLETED,
      path: normalizedPath,
      durationOff: true,
      waveform: { length: 200, max: 255 },
      codec: "aac,2",
      events: [
        {
          event_type: "attachment:audio_processed",
          payload: {
            workspaceId: ws,
            attachmentId: id,
            audio: {
              status: ProcessingStatuses.COMPLETED,
              durationMs: row.duration_ms,
              waveform: row.waveform,
              normalized: true,
            },
          },
        },
      ],
    })
  })

  test("should leave the upload's bytes alone when it is named like the normalized file", async () => {
    const upload = await sine("named-like-output.wav", [])
    const id = await seed("normalized.m4a", "audio/mp4", upload)

    await service.process(ws, id)

    const { row } = await observe(id)
    const stored = await storage.getObject(`${ws}/${id}/normalized.m4a`)
    expect({ status: row.processing_status, normalized: row.normalized_audio_storage_path !== null }).toEqual({
      status: ProcessingStatuses.COMPLETED,
      normalized: true,
    })
    expect(stored.equals(upload)).toBe(true)
  })

  test("should keep an MP3 as its own playable form and still store duration and waveform", async () => {
    const id = await seed("tone.mp3", "audio/mpeg", await sine("tone.mp3", ["-c:a", "libmp3lame", "-b:a", "96k"]))

    await service.process(ws, id)

    const { row, events } = await observe(id)
    expect({
      status: row.processing_status,
      path: row.normalized_audio_storage_path,
      durationOff: Math.abs(row.duration_ms - SOURCE_SECONDS * 1000) <= 100,
      waveform: waveformStats(row.waveform),
      events: events.map((event) => event.event_type),
    }).toEqual({
      status: ProcessingStatuses.COMPLETED,
      path: null,
      durationOff: true,
      waveform: { length: 200, max: 255 },
      events: ["attachment:audio_processed"],
    })
  })

  test("should mark random bytes named .wav failed and emit the failure without throwing", async () => {
    const id = await seed("noise.wav", "audio/wav", noise(4096))

    await service.process(ws, id)

    expect(await observe(id)).toEqual({
      row: {
        processing_status: ProcessingStatuses.FAILED,
        normalized_audio_storage_path: null,
        duration_ms: null,
        waveform: null,
      },
      events: [
        {
          event_type: "attachment:audio_processed",
          payload: { workspaceId: ws, attachmentId: id, audio: { status: ProcessingStatuses.FAILED } },
        },
      ],
    })
  })

  test("should fail a playlist uploaded as audio without fetching the URL it names", async () => {
    const fetched: string[] = []
    const decoy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        fetched.push(new URL(request.url).pathname)
        return new Response(null, { status: 404 })
      },
    })
    try {
      const playlist = [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:1",
        "#EXTINF:1.0,",
        `http://127.0.0.1:${decoy.port}/segment.ts`,
        "#EXT-X-ENDLIST",
        "",
      ].join("\n")
      const id = await seed("list.m3u8", "audio/x-mpegurl", Buffer.from(playlist))

      await service.process(ws, id)

      expect({ fetched, ...(await observe(id)) }).toEqual({
        fetched: [],
        row: {
          processing_status: ProcessingStatuses.FAILED,
          normalized_audio_storage_path: null,
          duration_ms: null,
          waveform: null,
        },
        events: [
          {
            event_type: "attachment:audio_processed",
            payload: { workspaceId: ws, attachmentId: id, audio: { status: ProcessingStatuses.FAILED } },
          },
        ],
      })
    } finally {
      await decoy.stop(true)
    }
  })

  test("should leave a completed attachment untouched when its job runs again", async () => {
    const id = await seed("again.wav", "audio/wav", await sine("again.wav", []))
    await service.process(ws, id)
    const before = await observe(id)

    await service.process(ws, id)

    expect(await observe(id)).toEqual(before)
  })
})
