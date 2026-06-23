#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { ChannelServer } from "./channel-server"
import { CONFIG_PATH, loadConfig, parseConfigFile, type RawConfig } from "./config"
import { ThreaClient } from "./threa-client"

function readFileConfig(): RawConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    return parseConfigFile(readFileSync(CONFIG_PATH, "utf8"))
  } catch (error) {
    process.stderr.write(
      `[threa-channel] ignoring ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return undefined
  }
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  return String(value)
}

/** The slice of `process` the lifecycle wiring touches, narrowed so it can be unit-tested with a fake. */
export interface LifecycleProcess {
  on(event: string, listener: (arg?: unknown) => void): unknown
  stdin: { on(event: string, listener: (arg?: unknown) => void): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): never
}

/**
 * Route every way the process can die through one graceful teardown, so the
 * channel marks presence offline + fails its in-flight claim instead of just
 * vanishing. Claude Code never respawns a dead stdio MCP server mid-session, so
 * a silent drop strands the scratchpad as "busy" with nobody to answer until a
 * human restarts. The paths covered:
 *  - SIGINT/SIGTERM — Claude Code's normal stop, and a 2nd Ctrl-C.
 *  - SIGHUP — terminal/SSH/tmux disconnect (previously an unhandled hard kill).
 *  - stdin end/close — the parent's write end closed: Claude Code exited, was
 *    killed, or was swapped out by an auto-update. The session we serve is gone,
 *    so exit rather than linger as an orphan that keeps renewing the claim.
 *  - uncaughtException/unhandledRejection — a steady-state throw would otherwise
 *    vanish the process with no log and no cleanup; log it and exit non-zero.
 */
export function wireLifecycle(server: { shutdown(): Promise<void> }, host: LifecycleProcess, exitGuardMs = 4000): void {
  let shuttingDown = false
  const shutdownAndExit = async (code: number, reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    host.stderr.write(`[threa-channel] shutting down (${reason})\n`)
    // Bound teardown so a hung Threa request can't hold us past Claude Code's
    // SIGTERM→SIGKILL grace window — exit even if presence/fail never lands.
    const guard = setTimeout(() => host.exit(code), exitGuardMs)
    if (guard && typeof guard === "object" && "unref" in guard) (guard as { unref(): void }).unref()
    await server.shutdown().catch(() => undefined)
    clearTimeout(guard)
    host.exit(code)
  }

  host.on("SIGINT", () => void shutdownAndExit(0, "SIGINT"))
  host.on("SIGTERM", () => void shutdownAndExit(0, "SIGTERM"))
  host.on("SIGHUP", () => void shutdownAndExit(0, "SIGHUP"))
  host.stdin.on("end", () => void shutdownAndExit(0, "stdin closed by parent"))
  host.stdin.on("close", () => void shutdownAndExit(0, "stdin closed by parent"))
  host.on("uncaughtException", (error) => {
    host.stderr.write(`[threa-channel] uncaughtException: ${describeError(error)}\n`)
    void shutdownAndExit(1, "uncaughtException")
  })
  host.on("unhandledRejection", (reason) => {
    host.stderr.write(`[threa-channel] unhandledRejection: ${describeError(reason)}\n`)
    void shutdownAndExit(1, "unhandledRejection")
  })
}

async function main(): Promise<void> {
  const result = loadConfig({ env: process.env, cwd: process.cwd(), hostname: hostname(), file: readFileConfig() })
  if ("error" in result) {
    process.stderr.write(`[threa-channel] ${result.error}\n`)
    process.exit(1)
  }

  const client = new ThreaClient(result.config)
  const server = new ChannelServer(result.config, client)

  // Connect stdio first so Claude Code registers the channel and discovers the
  // reply tool even while the Threa bridge is still spinning up. This also puts
  // stdin in flowing mode, so the parent-death end/close events below fire.
  await server.connectStdio()

  wireLifecycle(server, process as unknown as LifecycleProcess)

  // start() is best-effort internally (link/socket/presence self-heal on the
  // poll loop); an error escaping it is an unexpected init failure, so fail loud
  // — let it propagate to main().catch below, which logs and exits non-zero
  // rather than leaving a connected-but-dead channel Claude can't detect.
  await server.start()
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[threa-channel] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
