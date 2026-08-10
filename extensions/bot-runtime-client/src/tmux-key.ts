import { spawnSync, type SpawnSyncReturns } from "node:child_process"

export const TMUX_KEY_TOKENS = {
  escape: "Escape",
  enter: "Enter",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  backspace: "BSpace",
  "ctrl-c": "C-c",
  "ctrl-d": "C-d",
  "ctrl-u": "C-u",
} as const

export type AllowedTmuxKey = keyof typeof TMUX_KEY_TOKENS
export type TmuxKeyFailureCode = "target_unavailable" | "inspection_failed" | "identity_changed" | "send_failed"

export class TmuxKeyError extends Error {
  constructor(
    readonly code: TmuxKeyFailureCode,
    message: string
  ) {
    super(message)
    this.name = "TmuxKeyError"
  }
}

type Spawn = (command: string, args: string[], options: { encoding: "utf8" }) => SpawnSyncReturns<string>

export function parseAllowedTmuxKey(args: string): AllowedTmuxKey | undefined {
  const name = args.trim().toLowerCase()
  return Object.hasOwn(TMUX_KEY_TOKENS, name) ? (name as AllowedTmuxKey) : undefined
}

function resolveInspectedPane(output: string, target: string, expectedPid: number): string {
  const fields = output.match(/^([^\t\r\n]+)\t([1-9]\d*)\t([01])\n?$/)
  if (!fields) throw new TmuxKeyError("identity_changed", "tmux pane inspection was malformed")

  const [, paneId, panePid, paneDead] = fields
  if (paneId !== target) throw new TmuxKeyError("identity_changed", "tmux pane id changed")
  if (panePid !== String(expectedPid)) {
    throw new TmuxKeyError("identity_changed", "tmux pane process changed")
  }
  if (paneDead !== "0") throw new TmuxKeyError("identity_changed", "tmux pane is dead")
  return paneId
}

export function sendAllowedTmuxKey(key: AllowedTmuxKey, expectedPid: number, spawn: Spawn = spawnSync): void {
  const target = process.env.TMUX_PANE
  if (!target || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    throw new TmuxKeyError("target_unavailable", "tmux pane is unavailable")
  }

  const inspected = spawn("tmux", ["display-message", "-p", "-t", target, "#{pane_id}\t#{pane_pid}\t#{pane_dead}"], {
    encoding: "utf8",
  })
  if (inspected.error || inspected.status !== 0) {
    throw new TmuxKeyError("inspection_failed", "could not inspect tmux pane")
  }
  const paneId = resolveInspectedPane(inspected.stdout, target, expectedPid)

  const sent = spawn("tmux", ["send-keys", "-t", paneId, TMUX_KEY_TOKENS[key]], { encoding: "utf8" })
  if (sent.error || sent.status !== 0) {
    throw new TmuxKeyError("send_failed", "could not send key to tmux pane")
  }
}
