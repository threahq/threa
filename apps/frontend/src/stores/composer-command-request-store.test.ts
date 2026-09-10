import { expect, it } from "vitest"
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
    const offA = subscribeComposerCommandRequest("stream_shared", () => received.push("a"))
    queueComposerCommandRequest("stream_shared", "/private-command-a")

    setActiveDb(b)
    expect(consumeComposerCommandRequest("stream_shared")).toBeNull()
    const offB = subscribeComposerCommandRequest("stream_shared", () => received.push("b"))
    offA()
    queueComposerCommandRequest("stream_shared", "/command-b")
    expect(consumeComposerCommandRequest("stream_shared")).toBe("/command-b")
    offB()

    setActiveDb(a)
    expect(consumeComposerCommandRequest("stream_shared")).toBe("/private-command-a")
    expect(received).toEqual(["a", "b"])
  } finally {
    setActiveDb(previous)
    a.close()
    b.close()
  }
})
