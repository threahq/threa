import { expect, it, vi } from "vitest"
import { ThreaDatabase, getActiveDb, setActiveDb } from "@/db/database"
import {
  consumeComposerCommandRequest,
  queueComposerCommandRequest,
  subscribeComposerCommandRequest,
} from "./composer-command-request-store"

it("should keep a pending command and late unsubscribe with their originating account", () => {
  const previous = getActiveDb()
  const a = new ThreaDatabase("command_owner_a")
  const b = new ThreaDatabase("command_owner_b")
  const received: string[] = []
  try {
    setActiveDb(a)
    const offA = subscribeComposerCommandRequest("ws_1", "stream_shared", () => received.push("a"))
    queueComposerCommandRequest("ws_1", "stream_shared", "/private-command-a")

    setActiveDb(b)
    expect(consumeComposerCommandRequest("ws_1", "stream_shared")).toBeNull()
    const offB = subscribeComposerCommandRequest("ws_1", "stream_shared", () => received.push("b"))
    offA()
    queueComposerCommandRequest("ws_1", "stream_shared", "/command-b")
    expect(consumeComposerCommandRequest("ws_1", "stream_shared")).toBe("/command-b")
    offB()

    setActiveDb(a)
    expect(consumeComposerCommandRequest("ws_1", "stream_shared")).toBe("/private-command-a")
    expect(received).toEqual(["a", "b"])
  } finally {
    setActiveDb(previous)
    a.close()
    b.close()
  }
})

it("should keep a pending command with its workspace when another workspace shares the stream id", () => {
  const listenerB = vi.fn()
  const offB = subscribeComposerCommandRequest("ws_b", "stream_shared", listenerB)

  queueComposerCommandRequest("ws_a", "stream_shared", "/command-a")

  expect({
    consumedByB: consumeComposerCommandRequest("ws_b", "stream_shared"),
    listenerBCalls: listenerB.mock.calls.length,
    consumedByA: consumeComposerCommandRequest("ws_a", "stream_shared"),
  }).toEqual({ consumedByB: null, listenerBCalls: 0, consumedByA: "/command-a" })
  offB()
})
