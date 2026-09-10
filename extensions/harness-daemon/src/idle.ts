import { readFileSync } from "node:fs"
import type { ClaudeNativeSession } from "./claude-registry"
import type { ManagedAgent } from "./types"

/**
 * How long a Claude session must have been idle before the sweep winds it down.
 *
 * Long, because the runtime reports idle for work this process cannot see from
 * outside: a background subagent and a scheduled wake-up both run without a
 * child process to find, and killing either loses it. 90 minutes outlasts
 * almost all of that, and the sessions this exists for sit idle for days.
 */
export const IDLE_SUSPEND_AFTER_MS = 90 * 60_000

/**
 * Every Bash tool call Claude Code makes sources this snapshot, so a child
 * whose cmdline names one is work in flight — a build, a test run, a `sleep`
 * inside a wait loop — however idle the runtime's own status reads. The
 * runtime reports idle the instant it hands the turn back, and a backgrounded
 * job outlives that by design.
 */
const SHELL_SNAPSHOT_MARKER = "/shell-snapshots/snapshot-"

export interface IdleProbeDeps {
  /** Direct children of a pid; empty when the process is gone or /proc says nothing. */
  children: (pid: number) => number[]
  /** A pid's argv, NUL-separated as /proc gives it; empty when the process is gone. */
  cmdline: (pid: number) => string
  now: () => number
}

export function defaultIdleProbeDeps(): IdleProbeDeps {
  return {
    children: (pid) => procChildren(pid),
    cmdline: (pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      } catch {
        return ""
      }
    },
    now: Date.now,
  }
}

export function procChildren(pid: number, read: (path: string) => string = (p) => readFileSync(p, "utf8")): number[] {
  let raw: string
  try {
    raw = read(`/proc/${pid}/task/${pid}/children`)
  } catch {
    return []
  }
  return raw
    .split(/\s+/)
    .map((entry) => Number(entry))
    .filter((child) => Number.isSafeInteger(child) && child > 0)
}

export type IdleVerdict = { idle: true; idleForMs: number } | { idle: false; reason: string }

/**
 * Whether one Claude session has been doing nothing long enough to wind down.
 *
 * Every answer but "idle for long enough" is a refusal, including the ones a
 * missing field could make look like agreement: a registry entry with no
 * `statusUpdatedAt` (the SDK entrypoints write none) says nothing about how
 * long the session has been quiet, and guessing there suspends a working
 * agent.
 */
export function claudeIdleVerdict(
  session: ClaudeNativeSession,
  deps: IdleProbeDeps,
  thresholdMs = IDLE_SUSPEND_AFTER_MS
): IdleVerdict {
  if (session.status !== "idle") return { idle: false, reason: `runtime is ${session.status}` }
  if (session.statusUpdatedAt === undefined) return { idle: false, reason: "runtime records no idle timestamp" }
  const idleForMs = deps.now() - session.statusUpdatedAt
  if (idleForMs < thresholdMs) return { idle: false, reason: `idle for ${Math.round(idleForMs / 60_000)}m` }
  const job = backgroundShellJob(session.pid, deps)
  if (job !== undefined) return { idle: false, reason: `a Bash job is still running (pid ${job})` }
  return { idle: true, idleForMs }
}

/** The pid of the first shell job the session still has running, or undefined. */
export function backgroundShellJob(pid: number, deps: IdleProbeDeps): number | undefined {
  return deps.children(pid).find((child) => deps.cmdline(child).includes(SHELL_SNAPSHOT_MARKER))
}

/** Whether an operator or the agent itself asked the sweep to leave this row alone. */
export function suspendHeld(agent: ManagedAgent, nowMs: number): boolean {
  if (!agent.suspendHoldUntil) return false
  const until = Date.parse(agent.suspendHoldUntil)
  return Number.isFinite(until) && until > nowMs
}
