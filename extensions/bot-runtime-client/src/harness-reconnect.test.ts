import { describe, expect, it, mock } from "bun:test"
import { harnessReconnectAvailable, prepareHarnessClear, prepareHarnessReconnect } from "./harness-reconnect"

const filesystem = (events: unknown[]) => ({
  mkdir: (path: string, options: unknown) => events.push(["mkdir", path, options]),
  open: (path: string, flags: string, mode: number) => {
    events.push(["open", path, flags, mode])
    return 41
  },
  chmod: (path: string, mode: number) => events.push(["chmod", path, mode]),
  close: (fd: number) => events.push(["close", fd]),
  appendFile: (path: string, data: string, options: unknown) => events.push(["appendFile", path, data, options]),
})

describe("prepareHarnessReconnect", () => {
  it("reports availability only for the exact harness entrypoint", () => {
    expect(
      harnessReconnectAvailable({ entrypoint: "/exact/harnessd.ts", exists: (path) => path === "/exact/harnessd.ts" })
    ).toBe(true)
    expect(harnessReconnectAvailable({ entrypoint: "/missing/harnessd.ts", exists: () => false })).toBe(false)
  })

  it("starts detached with exact routing and private append-log stdio", () => {
    const events: unknown[] = []
    const unref = mock(() => events.push(["unref"]))
    const spawn = mock((...args: unknown[]) => {
      events.push(["spawn", ...args])
      return { on: () => undefined, unref }
    })
    const start = prepareHarnessReconnect("runtime_exact", "stream_exact", {
      force: true,
      entrypoint: "/repo/harnessd.ts",
      bunExecutable: "/bun",
      logPath: "/private/harnessd/reconnect.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: spawn as never,
    })

    expect(events).toEqual([])
    start()
    expect(events).toEqual([
      ["mkdir", "/private/harnessd", { recursive: true, mode: 0o700 }],
      ["chmod", "/private/harnessd", 0o700],
      ["open", "/private/harnessd/reconnect.log", "a", 0o600],
      ["chmod", "/private/harnessd/reconnect.log", 0o600],
      [
        "spawn",
        "/bun",
        ["/repo/harnessd.ts", "reconnect", "runtime_exact", "--root-stream-id", "stream_exact", "--force"],
        { detached: true, stdio: ["ignore", 41, 41] },
      ],
      ["unref"],
      ["close", 41],
    ])
    expect(() => start()).toThrow("already started")
  })

  it("logs a sanitized asynchronous spawn error without crashing after acknowledgement", async () => {
    const events: unknown[] = []
    let emitError: ((error: Error & { code?: unknown }) => void) | undefined
    const start = prepareHarnessReconnect("runtime_secret", "stream_secret", {
      entrypoint: "/secret/harnessd.ts",
      bunExecutable: "/secret/bun",
      logPath: "/logs/reconnect.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: (() => ({
        on: (_event: "error", listener: typeof emitError) => {
          emitError = listener
        },
        unref: () => undefined,
      })) as never,
    })

    start()
    queueMicrotask(() => emitError?.(Object.assign(new Error("/secret/bun runtime_secret"), { code: "ENOENT" })))
    await Promise.resolve()

    expect(events.slice(-2)).toEqual([
      ["close", 41],
      ["appendFile", "/logs/reconnect.log", "Harness reconnect launch failed (ENOENT)\n", { mode: 0o600 }],
    ])
    expect(JSON.stringify(events)).not.toContain("runtime_secret")
  })

  it("closes the parent log fd when spawn fails", () => {
    const events: unknown[] = []
    const start = prepareHarnessReconnect("runtime", "root", {
      entrypoint: "/harnessd.ts",
      logPath: "/logs/reconnect.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: (() => {
        throw new Error("spawn failed")
      }) as never,
    })
    expect(() => start()).toThrow("spawn failed")
    expect(events.at(-1)).toEqual(["close", 41])
  })

  it("preparation validates only identity and entrypoint", () => {
    const spawn = mock(() => ({ on: () => undefined, unref: () => undefined }))
    expect(() => prepareHarnessReconnect("", "root", { exists: () => true, spawn: spawn as never })).toThrow(
      "Runtime session"
    )
    expect(() => prepareHarnessReconnect("runtime", " ", { exists: () => true, spawn: spawn as never })).toThrow(
      "Root stream"
    )
    expect(() =>
      prepareHarnessReconnect("runtime", "root", { entrypoint: "/missing", exists: () => false, spawn: spawn as never })
    ).toThrow("entrypoint not found")
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe("prepareHarnessClear", () => {
  it("starts detached with the bare clear routing and private append-log stdio", () => {
    const events: unknown[] = []
    const unref = mock(() => events.push(["unref"]))
    const spawn = mock((...args: unknown[]) => {
      events.push(["spawn", ...args])
      return { on: () => undefined, unref }
    })
    const start = prepareHarnessClear("runtime_exact", {
      entrypoint: "/repo/harnessd.ts",
      bunExecutable: "/bun",
      logPath: "/private/harnessd/clear.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: spawn as never,
    })

    expect(events).toEqual([])
    start()
    expect(events).toEqual([
      ["mkdir", "/private/harnessd", { recursive: true, mode: 0o700 }],
      ["chmod", "/private/harnessd", 0o700],
      ["open", "/private/harnessd/clear.log", "a", 0o600],
      ["chmod", "/private/harnessd/clear.log", 0o600],
      ["spawn", "/bun", ["/repo/harnessd.ts", "clear", "runtime_exact"], { detached: true, stdio: ["ignore", 41, 41] }],
      ["unref"],
      ["close", 41],
    ])
    expect(() => start()).toThrow("already started")
  })

  it("logs a sanitized asynchronous spawn error without crashing after acknowledgement", async () => {
    const events: unknown[] = []
    let emitError: ((error: Error & { code?: unknown }) => void) | undefined
    const start = prepareHarnessClear("runtime_secret", {
      entrypoint: "/secret/harnessd.ts",
      bunExecutable: "/secret/bun",
      logPath: "/logs/clear.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: (() => ({
        on: (_event: "error", listener: typeof emitError) => {
          emitError = listener
        },
        unref: () => undefined,
      })) as never,
    })

    start()
    queueMicrotask(() => emitError?.(Object.assign(new Error("/secret/bun runtime_secret"), { code: "ENOENT" })))
    await Promise.resolve()

    expect(events.slice(-2)).toEqual([
      ["close", 41],
      ["appendFile", "/logs/clear.log", "Harness clear launch failed (ENOENT)\n", { mode: 0o600 }],
    ])
    expect(JSON.stringify(events)).not.toContain("runtime_secret")
  })

  it("closes the parent log fd when spawn fails", () => {
    const events: unknown[] = []
    const start = prepareHarnessClear("runtime", {
      entrypoint: "/harnessd.ts",
      logPath: "/logs/clear.log",
      exists: () => true,
      fs: filesystem(events),
      spawn: (() => {
        throw new Error("spawn failed")
      }) as never,
    })
    expect(() => start()).toThrow("spawn failed")
    expect(events.at(-1)).toEqual(["close", 41])
  })

  it("preparation validates only identity and entrypoint", () => {
    const spawn = mock(() => ({ on: () => undefined, unref: () => undefined }))
    expect(() => prepareHarnessClear(" ", { exists: () => true, spawn: spawn as never })).toThrow("Runtime session")
    expect(() =>
      prepareHarnessClear("runtime", { entrypoint: "/missing", exists: () => false, spawn: spawn as never })
    ).toThrow("entrypoint not found")
    expect(spawn).not.toHaveBeenCalled()
  })
})
