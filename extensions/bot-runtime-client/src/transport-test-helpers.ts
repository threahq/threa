import { afterEach, mock } from "bun:test"
import type { InvocationControlScheduler } from "./invocation-control"
import type { BotRuntimeTransport } from "./transport"
import type { BotRuntimeHello, BotRuntimeTransportOptions } from "./types"

export const TEST_TRANSPORT_REQUEST_CONFIG = {
  baseUrl: "https://app.example.test",
  workspaceId: "ws_1",
  apiKey: "threa_bk_test",
} as const

export function testTransportOptions(
  hello: BotRuntimeHello,
  overrides: Partial<BotRuntimeTransportOptions> = {}
): BotRuntimeTransportOptions {
  return { ...TEST_TRANSPORT_REQUEST_CONFIG, hello, ...overrides }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export class FakeScheduler implements InvocationControlScheduler {
  private nowMs = 0
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  private fired = 0

  get pendingCount(): number {
    return this.tasks.size
  }

  get firedCount(): number {
    return this.fired
  }

  get pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.at - this.nowMs)
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.tasks.set(id, { at: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  advanceBy(ms: number): void {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) break
      this.nowMs = next[1].at
      this.tasks.delete(next[0])
      this.fired++
      next[1].callback()
    }
    this.nowMs = target
  }
}

export interface CapturedRequest {
  url: string
  method: string
  body?: Record<string, unknown>
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
}

export function stubFetch(responder: (request: CapturedRequest) => Response | Promise<Response>): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    requests.push(request)
    return responder(request)
  }) as unknown as typeof fetch
  return requests
}

/** Restores `global.fetch` after each test; push spies onto the returned array to have them restored too. */
export function restoreFetchAfterEach(): { mockRestore(): void }[] {
  const originalFetch = global.fetch
  const spies: { mockRestore(): void }[] = []
  afterEach(() => {
    global.fetch = originalFetch
    for (const spy of spies.splice(0)) spy.mockRestore()
  })
  return spies
}

export interface FakeSocket {
  handlers: Record<string, (...args: unknown[]) => void>
  timeout: () => { emit: (...args: unknown[]) => void }
  emit: (...args: unknown[]) => void
  on: (event: string, callback: (...args: unknown[]) => void) => FakeSocket
  connect: ReturnType<typeof mock>
  disconnect: ReturnType<typeof mock>
  removeAllListeners: ReturnType<typeof mock>
}

type FakeSocketResponder = (event: string, payload: unknown, callback: (error: unknown, ack?: unknown) => void) => void

const ackHelloOnly: FakeSocketResponder = (event, _payload, callback) => {
  if (event === "bot:hello" && typeof callback === "function") callback(null, { ok: true })
}

export function fakeSocket(responder: FakeSocketResponder = ackHelloOnly): FakeSocket {
  const socket: FakeSocket = {
    handlers: {},
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    removeAllListeners: mock(() => {}),
    on(event, callback) {
      socket.handlers[event] = callback
      return socket
    },
    emit: (...args) => responder(args[0] as string, args[1], args.at(-1) as (error: unknown, ack?: unknown) => void),
    timeout: () => ({ emit: (...args) => socket.emit(...args) }),
  }
  return socket
}

export function attachReadySocket(transport: BotRuntimeTransport, socket: unknown): void {
  const mutable = transport as unknown as { socket: unknown; connected: boolean; helloReady: boolean }
  mutable.socket = socket
  mutable.connected = true
  mutable.helloReady = true
}
