#!/usr/bin/env bun
import { parseArgs } from "node:util"
import { PROD, THRESHOLDS } from "./config"
import { loadCredentials } from "./env"
import { bunExec } from "./github"
import { groupTemplates } from "./probes/logs"
import { summarizeRailway, short } from "./probes/revision"
import { diffFindings, renderRevision, renderSnapshot } from "./render"
import {
  clients,
  takeRevision,
  takeSnapshot,
  resolveExpectedSha,
  type Deps,
  type Snapshot,
  type SnapshotOptions,
} from "./snapshot"
import { exitCodeFor, worst, type Level } from "./types"

const SECTIONS = ["revision", "liveness", "pipelines", "logs", "resources"] as const
type Section = (typeof SECTIONS)[number]

const HELP = `monitor — post-launch production checks for Threa (read-only).

Usage: bun run monitor <command> [flags]

Commands:
  status    One snapshot: revision per plane, liveness, outbox/queues/agents, logs, resources. Exit 0 ok / 1 warn / 2 fail.
  verify    Poll until every plane serves <sha> (or a gate fails), then run status.
  watch     Repeat status, print only new/resolved findings.
  logs      Error/warn log lines grouped by template.
  deploys   Recent Railway deployments per service.

Flags:
  --sha <sha>        Expected revision (default: origin/main head via git ls-remote).
  --since <iso|Nm|Nh> Baseline for "since" comparisons (default: backend deploy time). 45m, 2h, or ISO.
  --only <a,b>       Sections for status/watch: ${SECTIONS.join(",")}.
  --skip <a,b>       Sections to leave out.
  --json             Machine output (full snapshot).
  --top <n>          Log templates to show (default 5; logs command default 15).
  --service <name>   logs: one of ${PROD.logServices.join(",")} (default all).
  --level <l>        logs: error|warn (default error).
  --grep <text>      logs: Railway filter text appended with AND.
  --timeout <Nm>     verify: give up after (default 40m).  --interval <Ns>: poll every (default 60s).
  --for <Nm>         watch: run for (default 60m).          --interval <Nm>: every (default 5m).

Credentials: RAILWAY_READONLY_TOKEN, DB_READ_PROXY_URL/SECRET, THREA_PROD_BASE_URL, THREA_PROD_READ_ONLY_API_KEY,
THREA_PROD_DEFAULT_WORKSPACE from env, else ~/.threa.env.agents. Missing ones skip their section loudly.`

export function parseDuration(v: string | undefined, fallbackMs: number): number {
  if (!v) return fallbackMs
  const m = /^(\d+)(ms|s|m|h)$/.exec(v.trim())
  if (!m) throw new Error(`bad duration: ${v} (use 30s, 5m, 2h)`)
  const n = Number(m[1])
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1000 : m[2] === "m" ? n * 60_000 : n * 3_600_000
}

export function parseSince(v: string | undefined, now: Date): string | undefined {
  if (!v) return undefined
  if (/^\d+(s|m|h)$/.test(v)) return new Date(now.getTime() - parseDuration(v, 0)).toISOString()
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`bad --since: ${v}`)
  return d.toISOString()
}

export function pickSections(only?: string, skip?: string): Set<Section> {
  const set = new Set<Section>(only ? [] : SECTIONS)
  const check = (s: string): Section => {
    if (!(SECTIONS as readonly string[]).includes(s)) throw new Error(`unknown section: ${s}`)
    return s as Section
  }
  for (const s of only?.split(",").filter(Boolean) ?? []) set.add(check(s))
  for (const s of skip?.split(",").filter(Boolean) ?? []) set.delete(check(s))
  return set
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function cmdStatus(deps: Deps, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const opts: SnapshotOptions = {
    sha: flags.sha as string | undefined,
    since: parseSince(flags.since as string | undefined, deps.now()),
    sections: pickSections(flags.only as string | undefined, flags.skip as string | undefined),
  }
  const snap = await takeSnapshot(deps, opts)
  console.log(flags.json ? JSON.stringify(snap, null, 2) : renderSnapshot(snap, { top: Number(flags.top ?? 5) }))
  return exitCodeFor(snap.level)
}

async function cmdVerify(deps: Deps, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const sha = await resolveExpectedSha(deps, flags.sha as string | undefined)
  const timeoutMs = parseDuration(flags.timeout as string | undefined, THRESHOLDS.verifyTimeoutMs)
  const intervalMs = parseDuration(flags.interval as string | undefined, THRESHOLDS.verifyIntervalMs)
  const deadline = deps.now().getTime() + timeoutMs
  let lastRender = ""
  let verdict: Level = "pending"
  for (;;) {
    const { revision, errors } = await takeRevision(deps, sha)
    const levels = revision.planes.map((p) => p.level)
    verdict = worst(levels)
    const rendered = [
      ...renderRevision(revision, deps.now()),
      ...errors.map((e) => `  ! ${e.section}: ${e.error}`),
    ].join("\n")
    if (rendered !== lastRender) {
      console.log(`${deps.now().toISOString().slice(11, 19)}Z\n${rendered}`)
      lastRender = rendered
    }
    if (verdict === "ok" || verdict === "fail") break
    if (deps.now().getTime() >= deadline) {
      console.log(`timeout after ${flags.timeout ?? "40m"}; planes not converged`)
      verdict = "fail"
      break
    }
    await sleep(intervalMs)
  }
  if (verdict !== "ok") return 2
  console.log(`all planes serve ${short(sha)}; running status`)
  return cmdStatus(deps, { ...flags, sha })
}

async function cmdWatch(deps: Deps, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const durationMs = parseDuration(flags.for as string | undefined, THRESHOLDS.watchDurationMs)
  const intervalMs = parseDuration(flags.interval as string | undefined, THRESHOLDS.watchIntervalMs)
  const opts: SnapshotOptions = {
    sha: flags.sha as string | undefined,
    since: parseSince(flags.since as string | undefined, deps.now()),
    sections: pickSections(flags.only as string | undefined, flags.skip as string | undefined),
  }
  const end = deps.now().getTime() + durationMs
  let prev: Snapshot | null = null
  let worstSeen: Level = "ok"
  for (;;) {
    const snap = await takeSnapshot(deps, opts)
    worstSeen = worst([worstSeen, snap.level])
    const stamp = snap.at.slice(11, 19) + "Z"
    if (!prev) {
      console.log(renderSnapshot(snap, { top: Number(flags.top ?? 5) }))
    } else {
      const { added, resolved } = diffFindings(prev.findings, snap.findings)
      if (!added.length && !resolved.length) console.log(`${stamp} ${snap.level} no change`)
      for (const f of added) console.log(`${stamp} + ${f.level} ${f.message}`)
      for (const f of resolved) console.log(`${stamp} − resolved: ${f.message}`)
    }
    prev = snap
    if (deps.now().getTime() + intervalMs > end) break
    await sleep(intervalMs)
  }
  return exitCodeFor(worstSeen)
}

async function cmdLogs(deps: Deps, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const { railway } = clients(deps)
  if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing")
  const now = deps.now()
  const since =
    parseSince(flags.since as string | undefined, now) ?? new Date(now.getTime() - 60 * 60_000).toISOString()
  const level = (flags.level as string | undefined) ?? "error"
  const service = flags.service as string | undefined
  const services = service ? [service] : [...PROD.logServices]
  const parts = [`(@level:${level})`, `(${services.map((s) => `@service:${s}`).join(" OR ")})`]
  if (flags.grep) parts.push(`(${flags.grep})`)
  const lines = await railway.environmentLogs({
    filter: parts.join(" AND "),
    after: since,
    limit: THRESHOLDS.logFetchLimit,
  })
  const templates = groupTemplates(lines)
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          since,
          level,
          services,
          count: lines.length,
          truncated: lines.length >= THRESHOLDS.logFetchLimit,
          templates,
          lines: flags.raw ? lines : undefined,
        },
        null,
        2
      )
    )
    return 0
  }
  console.log(
    `${lines.length}${lines.length >= THRESHOLDS.logFetchLimit ? "+" : ""} ${level} lines since ${since} across ${services.join(",")}`
  )
  for (const t of templates.slice(0, Number(flags.top ?? 15))) {
    console.log(
      `×${String(t.count).padEnd(4)} ${t.firstAt.slice(11, 19)}→${t.lastAt.slice(11, 19)} [${t.services.join(",")}]${t.noise ? ` (noise: ${t.noise})` : ""}\n      ${t.sample.slice(0, 300).replace(/\n/g, "\n      ")}`
    )
  }
  if (flags.raw) for (const l of lines) console.log(`${l.timestamp.slice(0, 19)} [${l.service}] ${l.message}`)
  return 0
}

async function cmdDeploys(deps: Deps, flags: Record<string, string | boolean | undefined>): Promise<number> {
  const { railway } = clients(deps)
  if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing")
  const deployments = await railway.listDeployments(Number(flags.top ?? 30))
  if (flags.json) {
    console.log(JSON.stringify(deployments, null, 2))
    return 0
  }
  const summary = summarizeRailway(deployments)
  for (const [service, { newest, serving }] of summary) {
    console.log(
      `${service.padEnd(14)} serving ${short(serving?.sha) ?? "?"} (${serving?.createdAt.slice(0, 16) ?? "?"})  newest ${newest.status} ${short(newest.sha) ?? "?"} ${newest.createdAt.slice(0, 16)}${newest.skippedReason ? ` (${newest.skippedReason})` : ""}`
    )
  }
  console.log("")
  for (const d of deployments)
    console.log(
      `${d.createdAt.slice(0, 16)} ${d.service.padEnd(14)} ${d.status.padEnd(9)} ${short(d.sha) ?? "?"}  ${(d.commitMessage ?? "").split("\n")[0].slice(0, 70)}`
    )
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      sha: { type: "string" },
      since: { type: "string" },
      only: { type: "string" },
      skip: { type: "string" },
      json: { type: "boolean" },
      raw: { type: "boolean" },
      top: { type: "string" },
      service: { type: "string" },
      level: { type: "string" },
      grep: { type: "string" },
      timeout: { type: "string" },
      interval: { type: "string" },
      for: { type: "string" },
      help: { type: "boolean" },
    },
  })
  const command = positionals[0]
  if (!command || values.help) {
    console.log(HELP)
    return command ? 0 : 3
  }
  const env = await loadCredentials()
  if (env.fromFile.length) console.error(`credentials: ${env.fromFile.join(", ")} loaded from ~/.threa.env.agents`)
  if (env.missing.length)
    console.error(`credentials missing: ${env.missing.join(", ")} (dependent sections are skipped)`)
  const deps: Deps = { fetchImpl: fetch, exec: bunExec, creds: env.creds, now: () => new Date() }
  const flags = values as Record<string, string | boolean | undefined>
  switch (command) {
    case "status":
      return cmdStatus(deps, flags)
    case "verify":
      return cmdVerify(deps, flags)
    case "watch":
      return cmdWatch(deps, flags)
    case "logs":
      return cmdLogs(deps, flags)
    case "deploys":
      return cmdDeploys(deps, flags)
    default:
      console.error(`unknown command: ${command}\n\n${HELP}`)
      return 3
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(3)
    }
  )
}
