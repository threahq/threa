import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { RealtimeElevenLabsStrategy } from "./realtime-elevenlabs"
import type { TranscriptionDelta, TranscriptionError } from "./strategy"

type Listener = (event: unknown) => void

let lastSocket: FakeWebSocket | null = null

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = FakeWebSocket.CONNECTING
  readonly sent: string[] = []
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

  send(data: string): void {
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
  const strategy = new RealtimeElevenLabsStrategy({ apiKey: "secret-key" })
  const openPromise = strategy.open({ model: "elevenlabs:scribe-v2-realtime" })
  // The socket is constructed synchronously inside open(); flush microtasks so
  // the listeners are attached, then simulate the upstream accepting the socket.
  await Promise.resolve()
  lastSocket!.simulateOpen()
  return { session: await openPromise, socket: lastSocket! }
}

describe("RealtimeElevenLabsStrategy connect", () => {
  test("connects with the model_id param and xi-api-key header", async () => {
    const { socket } = await openSession()
    expect(socket.url).toContain("model_id=scribe_v2_realtime")
    expect(socket.options).toMatchObject({ headers: { "xi-api-key": "secret-key" } })
  })

  test("requests VAD auto-commit so segments finalize on silence, not only on stop", async () => {
    const { socket } = await openSession()
    expect(socket.url).toContain("commit_strategy=vad")
  })

  test("passes language_code when a language is provided", async () => {
    const strategy = new RealtimeElevenLabsStrategy({ apiKey: "k" })
    const p = strategy.open({ model: "elevenlabs:scribe-v2-realtime", language: "sv" })
    await Promise.resolve()
    lastSocket!.simulateOpen()
    await p
    expect(lastSocket!.url).toContain("language_code=sv")
  })

  test("rejects if the socket closes before opening", async () => {
    const strategy = new RealtimeElevenLabsStrategy({ apiKey: "k" })
    const p = strategy.open({ model: "elevenlabs:scribe-v2-realtime" })
    await Promise.resolve()
    lastSocket!.dispatch("close", { code: 1006 })
    await expect(p).rejects.toThrow(/closed before open/)
  })
})

describe("RealtimeElevenLabsStrategy audio + transcripts", () => {
  test("pushAudio sends a base64 input_audio_chunk and accumulates audio ms", async () => {
    const { session, socket } = await openSession()
    // 32000 bytes of PCM16 mono @ 16kHz == 1000ms of audio.
    session.pushAudio(Buffer.alloc(32_000))
    expect(socket.sent).toHaveLength(1)
    const msg = JSON.parse(socket.sent[0])
    expect(msg).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: 16_000 })
    expect(typeof msg.audio_base_64).toBe("string")

    const result = await session.close()
    expect(result.totalAudioMs).toBe(1000)
  })

  test("flush sends a commit with empty audio", async () => {
    const { session, socket } = await openSession()
    await session.flush()
    const msg = JSON.parse(socket.sent.at(-1)!)
    expect(msg).toMatchObject({ message_type: "input_audio_chunk", commit: true, audio_base_64: "" })
  })

  test("partial_transcript emits an interim delta, committed_transcript a final one", async () => {
    const { session, socket } = await openSession()
    const deltas: TranscriptionDelta[] = []
    session.onDelta((d) => deltas.push(d))

    socket.dispatch("message", { data: JSON.stringify({ message_type: "partial_transcript", text: "hel" }) })
    socket.dispatch("message", { data: JSON.stringify({ message_type: "committed_transcript", text: "hello" }) })

    expect(deltas).toEqual([
      { text: "hel", isFinal: false },
      { text: "hello", isFinal: true },
    ])
  })

  test("input_error is surfaced via onError", async () => {
    const { session, socket } = await openSession()
    const errors: TranscriptionError[] = []
    session.onError((e) => errors.push(e))

    socket.dispatch("message", { data: JSON.stringify({ message_type: "input_error", error: "bad audio" }) })

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

    expect(errors).toEqual([{ code: "UPSTREAM_CLOSED", message: "ElevenLabs realtime closed (code 1006)" }])
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
