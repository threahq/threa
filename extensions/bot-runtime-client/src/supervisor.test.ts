import { afterEach, expect, mock, spyOn, test } from "bun:test"
import * as socketIoClient from "socket.io-client"
import { BotSupervisorTransport } from "./supervisor"

interface FakeSocket {
  handlers: Record<string, (...args: unknown[]) => void>
  emitted: string[]
  connect: ReturnType<typeof mock>
  disconnect: ReturnType<typeof mock>
  removeAllListeners: ReturnType<typeof mock>
  on: (event: string, cb: (...args: unknown[]) => void) => FakeSocket
  timeout: () => { emit: (event: string, callback: (error: unknown, ack: unknown) => void) => void }
}

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  mock.restore()
})

function makeFakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    handlers: {},
    emitted: [],
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    removeAllListeners: mock(() => {}),
    on(event, callback) {
      socket.handlers[event] = callback
      return socket
    },
    timeout: () => ({
      emit(event, callback) {
        socket.emitted.push(event)
        callback(null, { ok: true })
      },
    }),
  }
  return socket
}

test("supervisor subscribes without bot:hello and routes restored sessions", async () => {
  global.fetch = mock(
    async () => new Response(JSON.stringify({ wsUrl: "https://ws.example.test" }))
  ) as unknown as typeof fetch
  const socket = makeFakeSocket()
  spyOn(socketIoClient, "io").mockReturnValue(socket as unknown as ReturnType<typeof socketIoClient.io>)
  const ready = mock(() => {})
  const restored = mock(() => {})
  const transport = new BotSupervisorTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    onReady: ready,
    onSessionRestored: restored,
  })

  await transport.connect()
  socket.handlers.connect!()
  socket.handlers["bot:session_restored"]!({
    botId: "bot_1",
    instanceId: "inst_1",
    runtimeSessionId: "sess_1",
    rootStreamId: "stream_1",
  })

  expect(socket.emitted).toEqual(["bot:supervisor:subscribe"])
  expect(ready).toHaveBeenCalledTimes(1)
  expect(restored).toHaveBeenCalledWith({
    botId: "bot_1",
    instanceId: "inst_1",
    runtimeSessionId: "sess_1",
    rootStreamId: "stream_1",
  })
  transport.disconnect()
})

test("supervisor drops a failed socket so the harness can redial", async () => {
  global.fetch = mock(
    async () => new Response(JSON.stringify({ wsUrl: "https://ws.example.test" }))
  ) as unknown as typeof fetch
  const first = makeFakeSocket()
  const second = makeFakeSocket()
  const ioSpy = spyOn(socketIoClient, "io")
    .mockReturnValueOnce(first as unknown as ReturnType<typeof socketIoClient.io>)
    .mockReturnValueOnce(second as unknown as ReturnType<typeof socketIoClient.io>)
  const transport = new BotSupervisorTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    onReady: () => {},
    onSessionRestored: () => {},
  })

  await transport.connect()
  first.handlers.connect_error!(new Error("backend moved"))
  await transport.connect()

  expect(first.removeAllListeners).toHaveBeenCalledTimes(1)
  expect(first.disconnect).toHaveBeenCalledTimes(1)
  expect(ioSpy).toHaveBeenCalledTimes(2)
  transport.disconnect()
})

test("supervisor drops malformed restored payloads", async () => {
  global.fetch = mock(
    async () => new Response(JSON.stringify({ wsUrl: "https://ws.example.test" }))
  ) as unknown as typeof fetch
  const socket = makeFakeSocket()
  spyOn(socketIoClient, "io").mockReturnValue(socket as unknown as ReturnType<typeof socketIoClient.io>)
  const restored = mock(() => {})
  const transport = new BotSupervisorTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    onReady: () => {},
    onSessionRestored: restored,
  })

  await transport.connect()
  socket.handlers["bot:session_restored"]!({ runtimeSessionId: "sess_1" })

  expect(restored).not.toHaveBeenCalled()
  transport.disconnect()
})
