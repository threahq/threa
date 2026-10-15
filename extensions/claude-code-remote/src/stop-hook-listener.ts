import { rmSync } from "node:fs"
import { open } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { z } from "zod"

const textField = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? value : undefined),
  z.string().optional()
)

const hookPayloadSchema = z.object({
  hook_event_name: z.enum(["Stop", "StopFailure"]),
  transcript_path: textField,
  last_assistant_message: textField,
  error: textField,
  error_details: textField,
})

export type StopHookSignal =
  | { event: "Stop"; transcriptPath?: string; lastAssistantMessage?: string }
  | { event: "StopFailure"; transcriptPath?: string; error?: string; message?: string }

export function parseStopHookPayload(raw: string): StopHookSignal | undefined {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = hookPayloadSchema.safeParse(json)
  if (!parsed.success) return undefined
  const payload = parsed.data
  if (payload.hook_event_name === "Stop") {
    return {
      event: "Stop",
      transcriptPath: payload.transcript_path,
      lastAssistantMessage: payload.last_assistant_message,
    }
  }
  return {
    event: "StopFailure",
    transcriptPath: payload.transcript_path,
    error: payload.error,
    message: payload.last_assistant_message ?? payload.error_details,
  }
}

export class StopHookListener {
  private handler: ((signal: StopHookSignal) => void) | undefined

  private constructor(private readonly server: Server) {}

  /** Listen on `path`, replacing a stale socket file. Throws when it cannot bind. */
  static async listen(path: string, log: (message: string) => void): Promise<StopHookListener> {
    const server = createServer()
    const listener = new StopHookListener(server)
    server.on("connection", (socket) => {
      const chunks: Buffer[] = []
      socket.on("data", (chunk: Buffer) => chunks.push(chunk))
      socket.on("error", () => undefined)
      socket.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        const signal = parseStopHookPayload(raw)
        if (!signal) {
          log(`stop hook: ignoring unrecognized payload (${raw.length} bytes)`)
          return
        }
        listener.handler?.(signal)
      })
    })
    rmSync(path, { force: true })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(path, () => {
        server.off("error", reject)
        resolve()
      })
    })
    server.on("error", (error) => log(`stop hook: socket error: ${error.message}`))
    return listener
  }

  onSignal(handler: (signal: StopHookSignal) => void): void {
    this.handler = handler
  }

  /** Stops listening. The socket file stays: a replacement channel may already own that path. */
  async close(): Promise<void> {
    this.handler = undefined
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

const SCAN_CHUNK_BYTES = 1 << 20
const QUEUE_SCAN_BYTES = 4 << 20
const QUEUE_LINE_PREFIX = '{"type":"queue-operation",'
const LINE_BREAK = 0x0a

export interface TranscriptTurn {
  /** A line other than a queue entry carries the invocation id: Claude took the event in. */
  seen: boolean
  /** Claude queued input it has not taken yet, so another turn starts right after this stop. */
  pendingInput: boolean
}

function queueOperation(line: string): string | undefined {
  try {
    const operation = (JSON.parse(line) as { operation?: unknown }).operation
    return typeof operation === "string" ? operation : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the transcript from the end. Claude logs each queued input as an `enqueue`
 * entry and its intake as a later `dequeue` or `remove`, so replaying the entries from
 * the turn's intake (the earliest `<channel invocation_id="…">` line) onward, oldest
 * first, leaves what is still waiting. Entries queued before the intake are ignored: under
 * FIFO they were taken ahead of this turn's input, and Claude takes task notifications
 * without logging the intake. An intake with nothing left to take consumed one of those
 * earlier entries. The queue check covers only the last 4 MB; the id search runs to the
 * start of the file.
 */
export async function readTranscriptTurn(path: string, invocationId: string): Promise<TranscriptTurn> {
  const file = await open(path, "r")
  try {
    let end = (await file.stat()).size
    let carry = Buffer.alloc(0)
    let scanned = 0
    const newestFirst: string[] = []
    let sinceIntake: number | undefined
    // Escaped as it appears inside a JSON string; Claude's own tool calls carry the id as `"invocation_id":"…"`.
    const intake = `invocation_id=\\"${invocationId}\\"`
    let seen = false
    let queueSettled = false
    while (end > 0 && !(seen && queueSettled)) {
      const start = Math.max(0, end - SCAN_CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      await file.read(chunk, 0, chunk.length, start)
      const buffer = Buffer.concat([chunk, carry])
      end = start
      scanned += chunk.length
      // The first line of a chunk may continue in the chunk before it; it waits for that one.
      const firstBreak = start > 0 ? buffer.indexOf(LINE_BREAK) : -1
      if (start > 0 && firstBreak < 0) {
        carry = buffer
        continue
      }
      carry = buffer.subarray(0, Math.max(firstBreak, 0))
      const lines = buffer
        .subarray(firstBreak + 1)
        .toString("utf8")
        .split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (!line.startsWith(QUEUE_LINE_PREFIX)) {
          seen ||= line.includes(invocationId)
        } else if (!queueSettled) {
          const operation = queueOperation(line)
          if (operation) newestFirst.push(operation)
        }
        if (!queueSettled && line.includes(intake)) sinceIntake = newestFirst.length
      }
      if (scanned >= QUEUE_SCAN_BYTES) queueSettled = true
    }
    let waiting = 0
    for (const operation of newestFirst.slice(0, sinceIntake).reverse()) {
      waiting = operation === "enqueue" ? waiting + 1 : Math.max(0, waiting - 1)
    }
    return { seen, pendingInput: waiting > 0 }
  } finally {
    await file.close()
  }
}
