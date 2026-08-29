import { spawn, type ChildProcess } from "node:child_process"

// The reply endpoint caps `finalMessageMarkdown` at 50 000 characters; keep
// room for the truncation note.
export const MAX_OUTPUT_CHARS = 48_000
const KILL_GRACE_MS = 2_000

export type CommandOutcome =
  | { ok: true; stdout: string; truncated: boolean }
  | { ok: false; reason: "interrupted" }
  | { ok: false; reason: "timeout"; stderr: string }
  | { ok: false; reason: "exit"; code: number | null; signal: NodeJS.Signals | null; stderr: string }
  | { ok: false; reason: "spawn"; message: string }

export interface CommandRuntimeOptions {
  command: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Runs one command per turn. The turn's text goes to stdin, stdout is
 * collected as the reply, stderr streams out line by line. `interrupt()`
 * kills the running command, which is how `/stop` (and the interrupt half of
 * `/steer`) reach it. One command at a time: the SDK delivers one normal turn
 * at a time, so a second `run` while one is active is a caller bug.
 */
export class CommandRuntime {
  private active: { child: ChildProcess; interrupted: boolean } | undefined
  /** One stderr line at a time, as the command emits them; rebound per turn by the caller. */
  onStderrLine: ((line: string) => void) | undefined

  constructor(private readonly options: CommandRuntimeOptions) {}

  get busy(): boolean {
    return this.active !== undefined
  }

  run(input: string, extraEnv: Record<string, string> = {}): Promise<CommandOutcome> {
    if (this.active) throw new Error("a command is already running")
    const [file, ...args] = this.options.command
    if (!file) throw new Error("empty command")
    return new Promise((resolve) => {
      let child: ChildProcess
      try {
        // Own process group, so an interrupt reaches everything the command
        // spawned: killing only `sh` would leave its children holding stdout
        // open and the turn would never close.
        child = spawn(file, args, {
          cwd: this.options.cwd,
          env: { ...(this.options.env ?? process.env), ...extraEnv },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        })
      } catch (error) {
        resolve({ ok: false, reason: "spawn", message: error instanceof Error ? error.message : String(error) })
        return
      }
      const state = { child, interrupted: false }
      this.active = state
      let stdout = ""
      let truncated = false
      let stderr = ""
      let stderrLine = ""
      let timedOut = false
      const timer =
        this.options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              this.kill(child)
            }, this.options.timeoutMs)

      child.stdout!.setEncoding("utf8")
      child.stdout!.on("data", (chunk: string) => {
        if (stdout.length >= MAX_OUTPUT_CHARS) {
          truncated = true
          return
        }
        stdout += chunk
        if (stdout.length > MAX_OUTPUT_CHARS) {
          stdout = stdout.slice(0, MAX_OUTPUT_CHARS)
          truncated = true
        }
      })
      child.stderr!.setEncoding("utf8")
      child.stderr!.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4_000)
        stderrLine += chunk
        const lines = stderrLine.split("\n")
        stderrLine = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) this.onStderrLine?.(line)
      })
      child.on("error", (error) => {
        if (timer) clearTimeout(timer)
        this.active = undefined
        resolve({ ok: false, reason: "spawn", message: error.message })
      })
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer)
        if (stderrLine.trim()) this.onStderrLine?.(stderrLine)
        this.active = undefined
        if (state.interrupted) resolve({ ok: false, reason: "interrupted" })
        else if (timedOut) resolve({ ok: false, reason: "timeout", stderr })
        else if (code === 0) resolve({ ok: true, stdout, truncated })
        else resolve({ ok: false, reason: "exit", code, signal, stderr })
      })
      child.stdin!.on("error", () => undefined)
      child.stdin!.end(input)
    })
  }

  /** Kill the running command. True when there was one to kill (the SDK reads false as "control lost"). */
  interrupt(): boolean {
    const active = this.active
    if (!active) return true
    active.interrupted = true
    this.kill(active.child)
    return true
  }

  private kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const group = -child.pid
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(group, name)
      } catch {
        // already gone
      }
    }
    signal("SIGTERM")
    const hard = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signal("SIGKILL")
    }, KILL_GRACE_MS)
    hard.unref()
  }
}

/** The reply text for a finished command: its output, or a plain account of why there is none. */
export function describeOutcome(outcome: CommandOutcome, command: readonly string[]): string | undefined {
  const name = command[0] ?? "command"
  switch (outcome.ok ? "ok" : outcome.reason) {
    case "ok": {
      const done = outcome as Extract<CommandOutcome, { ok: true }>
      const body = done.stdout.trim() || "(no output)"
      return done.truncated ? `${body}\n\n_Output truncated at ${MAX_OUTPUT_CHARS} characters._` : body
    }
    case "interrupted":
      return undefined
    case "timeout":
      return `\`${name}\` was stopped after the turn timeout.${tail((outcome as { stderr: string }).stderr)}`
    case "exit": {
      const failed = outcome as Extract<CommandOutcome, { reason: "exit" }>
      const how = failed.signal ? `was killed by ${failed.signal}` : `exited with code ${failed.code}`
      return `\`${name}\` ${how}.${tail(failed.stderr)}`
    }
    case "spawn":
      return `Could not start \`${name}\`: ${(outcome as { message: string }).message}`
  }
}

function tail(stderr: string): string {
  const text = stderr.trim()
  return text ? `\n\n\`\`\`\n${text.slice(-1_500)}\n\`\`\`` : ""
}
