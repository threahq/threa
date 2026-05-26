import { describe, expect, it, mock } from "bun:test"
import { BotSocketRegistry } from "./bot-socket-registry"
import type { Socket } from "socket.io"

function fakeSocket(): { socket: Socket; disconnect: ReturnType<typeof mock> } {
  const disconnect = mock(() => {})
  return { socket: { disconnect } as unknown as Socket, disconnect }
}

const key = { workspaceId: "ws_1", botId: "bot_alice", instanceId: "inst_42" }

describe("BotSocketRegistry", () => {
  it("returns an empty list when nothing is registered", () => {
    const reg = new BotSocketRegistry()
    expect(reg.getSockets(key)).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it("tracks multiple sockets per instance and unregisters cleanly", () => {
    const reg = new BotSocketRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.register(key, a.socket)
    reg.register(key, b.socket)

    expect(reg.getSockets(key)).toHaveLength(2)
    expect(reg.size()).toBe(2)

    reg.unregister(key, a.socket)
    expect(reg.getSockets(key)).toEqual([b.socket])
    expect(reg.size()).toBe(1)

    reg.unregister(key, b.socket)
    expect(reg.getSockets(key)).toEqual([])
    expect(reg.size()).toBe(0)
  })

  it("keeps sockets isolated across (workspaceId, botId, instanceId)", () => {
    const reg = new BotSocketRegistry()
    const here = fakeSocket()
    const elsewhere = fakeSocket()
    reg.register(key, here.socket)
    reg.register({ ...key, instanceId: "inst_other" }, elsewhere.socket)

    expect(reg.getSockets(key)).toEqual([here.socket])
    expect(reg.getSockets({ ...key, instanceId: "inst_other" })).toEqual([elsewhere.socket])
  })

  it("disconnectInstance kicks every socket for that instance and returns the count", () => {
    const reg = new BotSocketRegistry()
    const a = fakeSocket()
    const b = fakeSocket()
    reg.register(key, a.socket)
    reg.register(key, b.socket)

    const kicked = reg.disconnectInstance(key)
    expect(kicked).toBe(2)
    expect(a.disconnect).toHaveBeenCalledWith(true)
    expect(b.disconnect).toHaveBeenCalledWith(true)
  })

  it("disconnectInstance is a no-op for unknown keys", () => {
    const reg = new BotSocketRegistry()
    expect(reg.disconnectInstance(key)).toBe(0)
  })
})
