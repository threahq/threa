import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { RealtimeDeepgramStrategy } from "./realtime-deepgram"
import type { TranscriptionDelta, TranscriptionError } from "./strategy"

type Listener = (event: unknown) => void

let lastSocket: FakeWebSocket | null = null

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  readonly sent: Array<string | Buffer> = []
  readonly url: string
  readonly options: unknown
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string, options?: unknown) {
    this.url = url
    this.options = options
    lastSocket = this
  }

  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }

  send(data: string | Buffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  dispatch(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event)
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatch("open", {})
  }
}

const realWebSocket = globalThis.WebSocket

beforeEach(() => {
  lastSocket = null
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
})

afterEach(() => {
  ;(globalThis as { WebSocket: unknown }).WebSocket = realWebSocket
})

async function openSession() {
  const strategy = new RealtimeDeepgramStrategy({ apiKey: "secret-key" })
  const openPromise = strategy.open({ model: "deepgram:nova-3" })
  await Promise.resolve()
  lastSocket!.simulateOpen()
  return { session: await openPromise, socket: lastSocket! }
}

describe("RealtimeDeepgramStrategy connect", () => {
  test("connects with the model and PCM16 params and a Token Authorization header", async () => {
    const { socket } = await openSession()
    expect(socket.url).toContain("model=nova-3")
    expect(socket.url).toContain("encoding=linear16")
    expect(socket.url).toContain("sample_rate=16000")
    expect(socket.url).toContain("channels=1")
    expect(socket.url).toContain("interim_results=true")
    expect(socket.options).toMatchObject({ headers: { Authorization: "Token secret-key" } })
  })

  test("requests endpointing so utterances finalize on silence, not only on stop", async () => {
    const { socket } = await openSession()
    expect(socket.url).toContain("endpointing=300")
  })

  test("defaults to multilingual auto-detect when no language is provided", async () => {
    const { socket } = await openSession()
    expect(socket.url).toContain("language=multi")
  })

  test("passes language when one is provided", async () => {
    const strategy = new RealtimeDeepgramStrategy({ apiKey: "k" })
    const p = strategy.open({ model: "deepgram:nova-3", language: "sv" })
    await Promise.resolve()
    lastSocket!.simulateOpen()
    await p
    expect(lastSocket!.url).toContain("language=sv")
    // The explicit language wins over the multilingual default.
    expect(lastSocket!.url).not.toContain("language=multi")
  })

  test("rejects if the socket closes before opening", async () => {
    const strategy = new RealtimeDeepgramStrategy({ apiKey: "k" })
    const p = strategy.open({ model: "deepgram:nova-3" })
    await Promise.resolve()
    lastSocket!.dispatch("close", { code: 1006 })
    await expect(p).rejects.toThrow(/closed before open/)
  })
})

describe("RealtimeDeepgramStrategy audio + transcripts", () => {
  test("pushAudio sends raw binary PCM and accumulates audio ms", async () => {
    const { session, socket } = await openSession()
    // 32000 bytes of PCM16 mono @ 16kHz == 1000ms of audio.
    const frame = Buffer.alloc(32_000)
    session.pushAudio(frame)
    expect(socket.sent[0]).toBe(frame)

    const result = await session.close()
    expect(result.totalAudioMs).toBe(1000)
  })

  test("flush sends CloseStream and resolves when the final Results frame arrives", async () => {
    const { session, socket } = await openSession()
    const deltas: TranscriptionDelta[] = []
    session.onDelta((d) => deltas.push(d))

    const flushed = session.flush()
    // CloseStream has been sent, but flush is still awaiting the final frame.
    const msg = JSON.parse(socket.sent.at(-1) as string)
    expect(msg).toEqual({ type: "CloseStream" })

    socket.dispatch("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "last word" }] },
      }),
    })

    await flushed
    expect(deltas).toEqual([{ text: "last word", isFinal: true }])
  })

  test("flush resolves on its safety timeout when no final frame ever lands", async () => {
    const { session } = await openSession()
    // The 1500ms guard timer is real; advance it explicitly so the test stays fast.
    // Using fake timers would cross-pollute the test file, so settle for a real
    // wait scoped to one short case.
    const flushed = session.flush()
    const start = Date.now()
    await flushed
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(1400)
  }, 5000)

  test("a server-initiated close after a successful flush does NOT surface an error", async () => {
    const { session, socket } = await openSession()
    const errors: TranscriptionError[] = []
    session.onError((e) => errors.push(e))

    const flushed = session.flush()
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "ok" }] },
      }),
    })
    await flushed
    // Deepgram closes the socket itself right after the final frame. That
    // socket teardown must not look like an unsolicited upstream drop.
    socket.dispatch("close", { code: 1000 })

    expect(errors).toEqual([])
  })

  test("Results with is_final=false emits an interim delta, is_final=true a final one", async () => {
    const { session, socket } = await openSession()
    const deltas: TranscriptionDelta[] = []
    session.onDelta((d) => deltas.push(d))

    socket.dispatch("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "hel" }] },
      }),
    })
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        channel: { alternatives: [{ transcript: "hello" }] },
      }),
    })

    expect(deltas).toEqual([
      { text: "hel", isFinal: false },
      { text: "hello", isFinal: true },
    ])
  })

  test("Results with empty transcript are ignored (keepalive frames)", async () => {
    const { session, socket } = await openSession()
    const deltas: TranscriptionDelta[] = []
    session.onDelta((d) => deltas.push(d))

    socket.dispatch("message", {
      data: JSON.stringify({
        type: "Results",
        is_final: false,
        channel: { alternatives: [{ transcript: "" }] },
      }),
    })

    expect(deltas).toEqual([])
  })

  test("Error is surfaced via onError", async () => {
    const { session, socket } = await openSession()
    const errors: TranscriptionError[] = []
    session.onError((e) => errors.push(e))

    socket.dispatch("message", { data: JSON.stringify({ type: "Error", error: "bad audio" }) })

    expect(errors).toEqual([{ code: "INPUT_ERROR", message: "bad audio" }])
  })

  test("close tears down the socket", async () => {
    const { session, socket } = await openSession()
    await session.close()
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  test("an unsolicited close after open surfaces an UPSTREAM_CLOSED error", async () => {
    const { session, socket } = await openSession()
    const errors: TranscriptionError[] = []
    session.onError((e) => errors.push(e))

    socket.dispatch("close", { code: 1006 })

    expect(errors).toEqual([{ code: "UPSTREAM_CLOSED", message: "Deepgram realtime closed (code 1006)" }])
  })

  test("a close we initiated via close() does not surface an error", async () => {
    const { session, socket } = await openSession()
    const errors: TranscriptionError[] = []
    session.onError((e) => errors.push(e))

    await session.close()
    socket.dispatch("close", { code: 1000 })

    expect(errors).toEqual([])
  })
})
