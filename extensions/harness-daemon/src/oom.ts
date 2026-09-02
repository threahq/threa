import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { classifyClaudePane, type ClaudePaneState } from "./claude-boot"
import type { LocalTmuxPane } from "./discovery"
import { output } from "./shell"
import { capturePane, typeLine } from "./tmux"
import type { ManagedAgent } from "./types"

/** One kernel OOM kill, as the kernel logs it: the victim and the cgroup it sat in. */
export interface OomKill {
  cursor: string
  at: Date
  /** The systemd scope of the victim's cgroup, e.g. `tmux-spawn-<uuid>.scope`. */
  scope: string
  pid: number
  comm: string
  anonRssKb?: number
}

// Both the global and the memcg shapes carry these three fields in this order:
//   oom-kill:constraint=CONSTRAINT_NONE,...,task_memcg=/user.slice/.../tmux-spawn-X.scope,task=bun,pid=834669,uid=1000
const OOM_LINE_RE = /task_memcg=([^,]+),task=([^,]+),pid=(\d+)/
// "Out of memory: Killed process 834669 (bun) total-vm:90328000kB, anon-rss:11178380kB, ..."
// "Memory cgroup out of memory: Killed process ..." for a per-pane cap.
const KILLED_LINE_RE = /Killed process (\d+) \(([^)]*)\).*?anon-rss:(\d+)kB/

/** Parse `journalctl -k -o json` output into kills, pairing each victim with its resident size. */
export function parseOomKills(jsonLines: string): OomKill[] {
  const kills: OomKill[] = []
  const byPid = new Map<number, OomKill>()
  for (const line of jsonLines.split("\n")) {
    if (!line.trim()) continue
    let row: { __CURSOR?: unknown; __REALTIME_TIMESTAMP?: unknown; MESSAGE?: unknown }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const message = typeof row.MESSAGE === "string" ? row.MESSAGE : ""
    const oom = OOM_LINE_RE.exec(message)
    if (oom && typeof row.__CURSOR === "string") {
      const micros = Number(row.__REALTIME_TIMESTAMP)
      const kill: OomKill = {
        cursor: row.__CURSOR,
        at: new Date(Number.isFinite(micros) ? Math.floor(micros / 1000) : 0),
        scope: basename(oom[1]!),
        comm: oom[2]!,
        pid: Number(oom[3]),
      }
      kills.push(kill)
      byPid.set(kill.pid, kill)
      continue
    }
    const killed = KILLED_LINE_RE.exec(message)
    if (killed) {
      const kill = byPid.get(Number(killed[1]))
      if (kill) kill.anonRssKb = Number(killed[3])
    }
  }
  return kills
}

/**
 * Kills the kernel logged in the last `windowSeconds`. Polled rather than
 * followed so the watcher keeps one process; `--since` and a cursor are
 * mutually exclusive in journalctl, so the caller dedupes by cursor instead.
 */
export function readRecentOomKills(windowSeconds: number, run: typeof output = output): OomKill[] {
  const result = run(
    ["journalctl", "-k", "-o", "json", "--no-pager", "--since", `-${windowSeconds}s`, "-g", "oom-kill:|Killed process"],
    { allowFailure: true }
  )
  // journalctl exits 1 when the pattern matches nothing; only stderr means it failed.
  if (result.exitCode !== 0 && result.stderr.trim()) throw new Error(`journalctl -k failed: ${result.stderr.trim()}`)
  return parseOomKills(result.stdout)
}

export interface OomKillWatch {
  /** Kills not returned by a previous call. */
  next(): OomKill[]
}

/**
 * Dedupes the polled kill list by journal cursor so each kill is acted on
 * once; a cursor is forgotten after twice the window. The first call only
 * records what is already in the window: a daemon restart inside it must not
 * re-tell a kill the previous daemon already delivered.
 */
export function createOomKillWatch(params: {
  read: () => OomKill[]
  windowMs: number
  now?: () => number
}): OomKillWatch {
  const seen = new Map<string, number>()
  const now = params.now ?? Date.now
  let baselined = false
  return {
    next() {
      const at = now()
      for (const [cursor, seenAt] of seen) if (at - seenAt > params.windowMs * 2) seen.delete(cursor)
      const fresh: OomKill[] = []
      for (const kill of params.read()) {
        if (seen.has(kill.cursor)) continue
        seen.set(kill.cursor, at)
        fresh.push(kill)
      }
      if (!baselined) {
        baselined = true
        return []
      }
      return fresh
    },
  }
}

/** The scope a live pane runs in, from its pid's cgroup; undefined once the process is gone. */
export function scopeOfPid(
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, "utf8")
): string | undefined {
  try {
    const line = read(`/proc/${pid}/cgroup`)
      .split("\n")
      .find((entry) => entry.startsWith("0::"))
    return line ? basename(line.slice(3).trim()) : undefined
  } catch {
    return undefined
  }
}

/**
 * The pane pid a dead scope was started for. tmux's scope description names it
 * ("tmux child pane 826815 launched by process 1592"), and the journal keeps
 * it after the cgroup is gone.
 */
export function panePidOfScope(scope: string, run: typeof output = output): number | undefined {
  const result = run(["journalctl", "--user", "-o", "cat", "--no-pager", "-u", scope, "-g", "tmux child pane"], {
    allowFailure: true,
  })
  const pid = Number(result.stdout.match(/tmux child pane (\d+)/)?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

export interface OomBriefTargets {
  /** The victim died inside a pane whose runtime is still up: tell it now. */
  live: Array<{ agent: ManagedAgent; pane: LocalTmuxPane; kill: OomKill }>
  /** The victim's pane is gone with the runtime: tell the revival. */
  revive: Array<{ agent: ManagedAgent; kill: OomKill }>
  unmatched: OomKill[]
}

/**
 * Which managed runtime each kill belongs to. A live pane is matched through
 * its pid's cgroup; a vanished one through the pane pid the sweep last saw,
 * against the pid the journal recorded for the scope.
 */
export function matchOomKills(
  kills: OomKill[],
  params: {
    live: Array<{ agent: ManagedAgent; pane: LocalTmuxPane }>
    vanished: Array<{ agent: ManagedAgent; lastPane?: LocalTmuxPane }>
    scopeOfPid: (pid: number) => string | undefined
    panePidOfScope: (scope: string) => number | undefined
  }
): OomBriefTargets {
  const targets: OomBriefTargets = { live: [], revive: [], unmatched: [] }
  for (const kill of kills) {
    const live = params.live.find(({ pane }) => params.scopeOfPid(pane.panePid) === kill.scope)
    if (live) {
      targets.live.push({ ...live, kill })
      continue
    }
    const panePid = params.panePidOfScope(kill.scope)
    const gone = panePid === undefined ? undefined : params.vanished.find((v) => v.lastPane?.panePid === panePid)
    if (gone) targets.revive.push({ agent: gone.agent, kill })
    else targets.unmatched.push(kill)
  }
  return targets
}

function clock(at: Date): string {
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function resident(kill: OomKill): string {
  return kill.anonRssKb === undefined ? "" : `, ${(kill.anonRssKb / 1024 / 1024).toFixed(1)} GB resident`
}

/** Typed into a runtime that survived the kill of one of its children. One line: it is submitted with Enter. */
export function formatOomSteer(kill: OomKill): string {
  return (
    `[OOM] At ${clock(kill.at)} the kernel killed pid ${kill.pid} (${kill.comm}${resident(kill)}) inside this session's pane. ` +
    "Whatever command that was did not finish; its exit code 137 is this kill, not a test failure. " +
    "Do not rerun it as-is: find what made it grow first."
  )
}

/** Typed into a runtime harnessd revived after the kill took its predecessor down. */
export function formatOomRevivalBrief(kill: OomKill): string {
  return (
    `[OOM recovery] harnessd revived this session after the kernel killed pid ${kill.pid} (${kill.comm}${resident(kill)}) ` +
    `in its pane at ${clock(kill.at)} and the runtime went down with it. ` +
    "Pick up the work where the transcript ends; if the scratchpad turn you were answering comes back, answer it there. " +
    "Do not rerun the killed command as-is: find what made it grow first."
  )
}

export interface TypeBriefDeps {
  capture: (paneId: string) => string
  classify: (text: string) => ClaudePaneState
  type: (paneId: string, text: string) => boolean
  log: (message: string) => void
}

/**
 * Type a brief into a runtime's pane, or refuse. A Claude pane parked at a
 * dialog or menu would take the line as its answer, so only an idle composer
 * qualifies — or a running turn too, when the caller knows the runtime was up
 * before the kill (`idle-or-working`). Pi has no such prompts.
 */
export function typeBrief(
  params: {
    agent: Pick<ManagedAgent, "name" | "runtime">
    paneId: string
    text: string
    allow: "idle" | "idle-or-working"
  },
  deps: TypeBriefDeps = { capture: capturePane, classify: classifyClaudePane, type: typeLine, log: console.warn }
): boolean {
  if (params.agent.runtime === "claude") {
    const state = deps.classify(deps.capture(params.paneId))
    const allowed = state === "idle" || (params.allow === "idle-or-working" && state === "working")
    if (!allowed) {
      deps.log(`harnessd: ${params.agent.name} is not at an idle composer (${state}); the brief stays pending`)
      return false
    }
  }
  if (!deps.type(params.paneId, params.text)) {
    deps.log(`harnessd: ${params.agent.name}'s pane ${params.paneId} refused the keys; the brief stays pending`)
    return false
  }
  return true
}

/** A brief no pane took (archived, occupied, never idle) must not surface on an unrelated restart hours later. */
export const PENDING_BRIEF_TTL_MS = 60 * 60_000

export interface BriefQueueDeps {
  type: (params: Parameters<typeof typeBrief>[0]) => boolean
  notify: (agent: ManagedAgent, content: string) => Promise<void>
  log: (message: string) => void
  dryRun: boolean
  ttlMs?: number
  now?: () => number
}

export interface BriefQueue {
  /** File each matched kill against its row and post its scratchpad notice; unmatched kills are logged only. */
  record(targets: OomBriefTargets): Promise<void>
  /** Offer every pending brief to its row's verified live pane; a typed brief is dropped, the rest wait for a later pass. */
  deliver(live: Array<{ agent: ManagedAgent; pane: LocalTmuxPane }>): Promise<void>
}

/**
 * The scratchpad notice goes out as soon as the kill is matched, so the person
 * reading learns the why even if the runtime never takes the brief. The brief
 * itself waits until a verified live pane for that row takes it: a survivor's
 * pane on the same pass, or the pane its revival opens on a later one. It
 * stays pending while the composer is busy or at a prompt, and it is never
 * typed under `dryRun` — the only path here that touches a pane.
 */
export function createBriefQueue(deps: BriefQueueDeps): BriefQueue {
  const pending = new Map<string, { agent: ManagedAgent; kill: OomKill; survivorPanePid?: number }>()
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? PENDING_BRIEF_TTL_MS
  return {
    async record(targets) {
      for (const kill of targets.unmatched) {
        deps.log(`harnessd: OOM kill outside managed panes: ${kill.comm} pid ${kill.pid} in ${kill.scope}`)
      }
      for (const { agent, pane, kill } of targets.live) {
        pending.set(agent.id, { agent, kill, survivorPanePid: pane.panePid })
        if (!deps.dryRun) await deps.notify(agent, formatOomNotice(kill, "survived"))
      }
      for (const { agent, kill } of targets.revive) {
        pending.set(agent.id, { agent, kill })
        if (!deps.dryRun) await deps.notify(agent, formatOomNotice(kill, "revived"))
      }
      const staleBefore = now() - ttlMs
      for (const [id, { agent, kill }] of pending) {
        if (kill.at.getTime() >= staleBefore) continue
        pending.delete(id)
        deps.log(
          `harnessd: dropped an undelivered OOM brief for ${agent.name} (${kill.comm} pid ${kill.pid}); no idle pane took it`
        )
      }
    },
    async deliver(live) {
      for (const { agent, pane } of live) {
        const entry = pending.get(agent.id)
        if (!entry) continue
        // The same pane pid as at the kill means the runtime survived and may
        // be mid-turn; any other pane is a revival, which must be at an idle
        // composer (an unrendered one classifies as "working").
        const survived = entry.survivorPanePid === pane.panePid
        if (deps.dryRun) {
          deps.log(`harnessd: would tell ${agent.name} (${survived ? "survived" : "revived"}) about the OOM kill`)
          continue
        }
        const typed = deps.type({
          agent,
          paneId: pane.paneId,
          text: survived ? formatOomSteer(entry.kill) : formatOomRevivalBrief(entry.kill),
          allow: survived ? "idle-or-working" : "idle",
        })
        if (!typed) continue
        pending.delete(agent.id)
        deps.log(`harnessd: told ${agent.name} about the OOM kill (${entry.kill.comm} pid ${entry.kill.pid})`)
      }
    },
  }
}

/** Posted to the scratchpad when the kill is matched, so the person reading it learns the why without opening a terminal. */
export function formatOomNotice(kill: OomKill, outcome: "survived" | "revived"): string {
  const victim = `\`${kill.comm}\` (pid ${kill.pid}${resident(kill)})`
  return outcome === "survived"
    ? `⚠️ OOM in this session's pane at ${clock(kill.at)}: the kernel killed ${victim}. The session survived; harnessd is telling it.`
    : `⚠️ OOM in this session's pane at ${clock(kill.at)}: the kernel killed ${victim} and the session with it. harnessd is reviving it and will brief it.`
}

/** Post a bot-authored line to a scratchpad through the workspace API; throws on a non-2xx so the caller can log it. */
export async function postScratchpadNotice(params: {
  baseUrl: string
  workspaceId: string
  apiKey: string
  streamId: string
  content: string
}): Promise<void> {
  const response = await fetch(
    `${params.baseUrl.replace(/\/$/, "")}/api/v1/workspaces/${params.workspaceId}/streams/${params.streamId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${params.apiKey}` },
      body: JSON.stringify({ content: params.content }),
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!response.ok) throw new Error(`scratchpad notice returned ${response.status}`)
}
