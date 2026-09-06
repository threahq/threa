import { spawn as nodeSpawn } from "node:child_process"
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { harnessDaemonEntrypoint } from "./harness-kick"

type DetachedChild = { on(event: "error", listener: (error: Error & { code?: unknown }) => void): void; unref(): void }

type HarnessSpawn = (
  executable: string,
  args: string[],
  options: { detached: true; stdio: ["ignore", number, number] }
) => DetachedChild

interface HarnessReconnectFs {
  mkdir(path: string, options: { recursive: true; mode: number }): void
  open(path: string, flags: string, mode: number): number
  chmod(path: string, mode: number): void
  close(fd: number): void
  appendFile(path: string, data: string, options: { mode: number }): void
}

export interface PrepareHarnessReconnectOptions {
  force?: boolean
  entrypoint?: string
  bunExecutable?: string
  exists?: (path: string) => boolean
  spawn?: HarnessSpawn
  logPath?: string
  fs?: HarnessReconnectFs
}

export type PrepareHarnessClearOptions = Omit<PrepareHarnessReconnectOptions, "force">

export function harnessReconnectAvailable(
  options: Pick<PrepareHarnessReconnectOptions, "entrypoint" | "exists"> = {}
): boolean {
  return (options.exists ?? existsSync)(options.entrypoint ?? harnessDaemonEntrypoint())
}

function requireHarnessEntrypoint(options: PrepareHarnessClearOptions): string {
  const entrypoint = options.entrypoint ?? harnessDaemonEntrypoint()
  if (!harnessReconnectAvailable(options)) throw new Error(`Harness daemon entrypoint not found: ${entrypoint}`)
  return entrypoint
}

function requireId(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is missing.`)
  return trimmed
}

function prepareDetachedHarnessCommand(
  command: "reconnect" | "clear" | "spawn" | "done",
  args: string[],
  options: PrepareHarnessClearOptions
): () => void {
  let started = false
  return () => {
    if (started) throw new Error(`Harness ${command} was already started.`)
    started = true
    const bunExecutable = (options.bunExecutable ?? process.env.THREA_HARNESSD_BUN_BIN?.trim()) || "bun"
    const logPath = options.logPath ?? join(homedir(), ".threa", "harnessd", `${command}.log`)
    const fs = options.fs ?? {
      mkdir: mkdirSync,
      open: openSync,
      chmod: chmodSync,
      close: closeSync,
      appendFile: appendFileSync,
    }
    const logDir = dirname(logPath)
    fs.mkdir(logDir, { recursive: true, mode: 0o700 })
    fs.chmod(logDir, 0o700)
    const logFd = fs.open(logPath, "a", 0o600)
    try {
      fs.chmod(logPath, 0o600)
      const spawn = options.spawn ?? (nodeSpawn as HarnessSpawn)
      const child = spawn(bunExecutable, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      })
      child.on("error", (error) => {
        const code = typeof error.code === "string" && /^E[A-Z0-9_]{1,31}$/.test(error.code) ? ` (${error.code})` : ""
        try {
          fs.appendFile(logPath, `Harness ${command} launch failed${code}\n`, { mode: 0o600 })
        } catch {}
      })
      child.unref()
    } finally {
      fs.close(logFd)
    }
  }
}

export function prepareHarnessReconnect(
  runtimeSessionId: string,
  rootStreamId: string,
  options: PrepareHarnessReconnectOptions = {}
): () => void {
  const session = requireId(runtimeSessionId, "Runtime session id")
  const rootStream = requireId(rootStreamId, "Root stream id")
  const entrypoint = requireHarnessEntrypoint(options)
  const args = [entrypoint, "reconnect", session, "--root-stream-id", rootStream]
  if (options.force) args.push("--force")
  return prepareDetachedHarnessCommand("reconnect", args, options)
}

export function prepareHarnessClear(runtimeSessionId: string, options: PrepareHarnessClearOptions = {}): () => void {
  const session = requireId(runtimeSessionId, "Runtime session id")
  const entrypoint = requireHarnessEntrypoint(options)
  return prepareDetachedHarnessCommand("clear", [entrypoint, "clear", session], options)
}

export interface HarnessSpawnSpec {
  runtime: "claude" | "pi"
  name: string
  rootStreamId: string
  anchorId: string
  briefFile?: string
}

export function prepareHarnessSpawn(spec: HarnessSpawnSpec, options: PrepareHarnessClearOptions = {}): () => void {
  const name = requireId(spec.name, "Agent name")
  const rootStream = requireId(spec.rootStreamId, "Root stream id")
  const anchor = requireId(spec.anchorId, "Anchor id")
  const entrypoint = requireHarnessEntrypoint(options)
  const args = [entrypoint, "spawn", spec.runtime, "--name", name, "--attach", rootStream, "--anchor", anchor]
  if (spec.briefFile) args.push("--brief-file", spec.briefFile)
  return prepareDetachedHarnessCommand("spawn", args, options)
}

export function prepareHarnessDone(
  runtimeSessionId: string,
  rootStreamId: string,
  options: PrepareHarnessClearOptions = {}
): () => void {
  const session = requireId(runtimeSessionId, "Runtime session id")
  const rootStream = requireId(rootStreamId, "Root stream id")
  const entrypoint = requireHarnessEntrypoint(options)
  return prepareDetachedHarnessCommand(
    "done",
    [entrypoint, "done", session, "--root-stream-id", rootStream],
    options
  )
}
