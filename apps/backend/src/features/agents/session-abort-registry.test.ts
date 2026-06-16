import { describe, expect, test } from "bun:test"
import { SessionAbortRegistry } from "./session-abort-registry"

describe("SessionAbortRegistry", () => {
  test("register returns a fresh AbortController for a new sessionId", () => {
    const registry = new SessionAbortRegistry()
    const controller = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    expect(controller).toBeInstanceOf(AbortController)
    expect(controller.signal.aborted).toBe(false)
  })

  test("register is idempotent for the same sessionId", () => {
    const registry = new SessionAbortRegistry()
    const a = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    const b = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    expect(a).toBe(b)
  })

  test("get returns the registered controller", () => {
    const registry = new SessionAbortRegistry()
    const controller = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    expect(registry.get("session_1")).toBe(controller)
  })

  test("get returns undefined for unknown session", () => {
    const registry = new SessionAbortRegistry()
    expect(registry.get("missing")).toBeUndefined()
  })

  test("abort fires the registered controller and returns true", () => {
    const registry = new SessionAbortRegistry()
    const controller = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    expect(registry.abort("session_1", "user_abort")).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  test("abort returns false for unknown session", () => {
    const registry = new SessionAbortRegistry()
    expect(registry.abort("missing")).toBe(false)
  })

  test("abort is safe to call after unregister", () => {
    const registry = new SessionAbortRegistry()
    registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    registry.unregister("session_1")
    expect(registry.abort("session_1")).toBe(false)
  })

  test("unregister removes the entry", () => {
    const registry = new SessionAbortRegistry()
    registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    registry.unregister("session_1")
    expect(registry.get("session_1")).toBeUndefined()
  })

  test("unregister is safe to call when no entry exists", () => {
    const registry = new SessionAbortRegistry()
    registry.unregister("never-registered")
    expect(registry.get("never-registered")).toBeUndefined()
  })

  test("re-register after unregister returns a fresh controller", () => {
    const registry = new SessionAbortRegistry()
    const first = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    registry.abort("session_1")
    registry.unregister("session_1")
    const second = registry.register("session_1", { workspaceId: "ws_1", streamId: "stream_1" })
    expect(second).not.toBe(first)
    expect(second.signal.aborted).toBe(false)
  })

  test("multiple sessions are isolated", () => {
    const registry = new SessionAbortRegistry()
    const a = registry.register("session_a", { workspaceId: "ws_1", streamId: "stream_1" })
    const b = registry.register("session_b", { workspaceId: "ws_1", streamId: "stream_2" })
    registry.abort("session_a")
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
  })
})
