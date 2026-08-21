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
  type Section,
  type Snapshot,
  type SnapshotOptions,
} from "./snapshot"
import { exitCodeFor, worst, type Level } from "./types"

const SECTIONS: readonly Section[] = ["revision", "liveness", "pipelines", "logs", "resources"]

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
  --json             Machine output. status/verify: the snapshot; watch: one JSON line per poll; logs/deploys: the data.
  --top <n>          Log templates to show (default 5; logs command default 15).
  --service <name>   logs: one of ${PROD.logServices.join(",")} (default all).
  --level <l>        logs: error|warn (default error).
  --grep <text>      logs: Railway filter text appended with AND.
  --timeout <Nm>     verify: give up after (default 40m).  --interval <Ns>: poll every (default 60s).
  --for <Nm>         watch: run for (default 60m).          --interval <Nm>: every (default 5m).

Credentials: RAILWAY_READONLY_TOKEN, DB_READ_PROXY_URL/SECRET, THREA_PROD_BASE_URL, THREA_PROD_READ_ONLY_API_KEY,
THREA_PROD_DEFAULT_WORKSPACE from env, else ~/.threa.env.agents. Missing ones skip their section loudly.`

type Flags = Record<string, string | boolean | undefined>

export function parseDuration(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim())
  if (!match) throw new Error(`bad duration: ${value} (use 30s, 5m, 2h)`)
  const amount = Number(match[1])
  const unit = match[2]
  return unit === "ms" ? amount : unit === "s" ? amount * 1000 : unit === "m" ? amount * 60_000 : amount * 3_600_000
}

export function parseSince(value: string | undefined, now: Date): string | undefined {
  if (!value) return undefined
  if (/^\d+(s|m|h)$/.test(value)) return new Date(now.getTime() - parseDuration(value, 0)).toISOString()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`bad --since: ${value}`)
  return date.toISOString()
}

export function pickSections(only?: string, skip?: string): Set<Section> {
  const sections = new Set<Section>(only ? [] : SECTIONS)
  const check = (name: string): Section => {
    if (!SECTIONS.includes(name as Section)) throw new Error(`unknown section: ${name}`)
    return name as Section
  }
  for (const name of only?.split(",").filter(Boolean) ?? []) sections.add(check(name))
  for (const name of skip?.split(",").filter(Boolean) ?? []) sections.delete(check(name))
  return sections
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function snapshotOptions(flags: Flags, now: Date): SnapshotOptions {
  return {
    sha: flags.sha as string | undefined,
    since: parseSince(flags.since as string | undefined, now),
    sections: pickSections(flags.only as string | undefined, flags.skip as string | undefined),
  }
}

async function cmdStatus(deps: Deps, flags: Flags): Promise<number> {
  const snapshot = await takeSnapshot(deps, snapshotOptions(flags, deps.now()))
  console.log(
    flags.json ? JSON.stringify(snapshot, null, 2) : renderSnapshot(snapshot, { top: Number(flags.top ?? 5) })
  )
  return exitCodeFor(snapshot.level)
}

async function cmdVerify(deps: Deps, flags: Flags): Promise<number> {
  const sha = await resolveExpectedSha(deps, flags.sha as string | undefined)
  const timeoutMs = parseDuration(flags.timeout as string | undefined, THRESHOLDS.verifyTimeoutMs)
  const intervalMs = parseDuration(flags.interval as string | undefined, THRESHOLDS.verifyIntervalMs)
  const deadline = deps.now().getTime() + timeoutMs
  // Progress goes to stderr under --json so stdout stays a single JSON document (the final status).
  const progress = flags.json ? console.error : console.log
  let lastRender = ""
  let verdict: Level = "pending"
  for (;;) {
    const { revision, errors } = await takeRevision(deps, sha)
    verdict = worst(revision.planes.map((plane) => plane.level))
    const rendered = [
      ...renderRevision(revision, deps.now()),
      ...errors.map((sectionError) => `  ! ${sectionError.section}: ${sectionError.error}`),
    ].join("\n")
    if (rendered !== lastRender) {
      progress(`${deps.now().toISOString().slice(11, 19)}Z\n${rendered}`)
      lastRender = rendered
    }
    if (verdict === "ok" || verdict === "fail") break
    if (deps.now().getTime() >= deadline) {
      progress(`timeout after ${flags.timeout ?? "40m"}; planes not converged`)
      verdict = "fail"
      break
    }
    await sleep(intervalMs)
  }
  if (verdict !== "ok") {
    if (flags.json) console.log(JSON.stringify({ verified: false, sha, verdict }))
    return 2
  }
  progress(`all planes serve ${short(sha)}; running status`)
  return cmdStatus(deps, { ...flags, sha })
}

async function cmdWatch(deps: Deps, flags: Flags): Promise<number> {
  const durationMs = parseDuration(flags.for as string | undefined, THRESHOLDS.watchDurationMs)
  const intervalMs = parseDuration(flags.interval as string | undefined, THRESHOLDS.watchIntervalMs)
  const opts = snapshotOptions(flags, deps.now())
  const end = deps.now().getTime() + durationMs
  let prev: Snapshot | null = null
  let worstSeen: Level = "ok"
  for (;;) {
    const snapshot = await takeSnapshot(deps, opts)
    worstSeen = worst([worstSeen, snapshot.level])
    const stamp = snapshot.at.slice(11, 19) + "Z"
    const { added, resolved } = prev
      ? diffFindings(prev.findings, snapshot.findings)
      : { added: snapshot.findings, resolved: [] }
    if (flags.json) {
      // One JSON line per poll: the first carries the full snapshot, later ones only the deltas.
      console.log(
        JSON.stringify(
          prev
            ? { at: snapshot.at, level: snapshot.level, added, resolved }
            : { at: snapshot.at, level: snapshot.level, snapshot }
        )
      )
    } else if (!prev) {
      console.log(renderSnapshot(snapshot, { top: Number(flags.top ?? 5) }))
    } else {
      if (!added.length && !resolved.length) console.log(`${stamp} ${snapshot.level} no change`)
      for (const finding of added) console.log(`${stamp} + ${finding.level} ${finding.message}`)
      for (const finding of resolved) console.log(`${stamp} − resolved: ${finding.message}`)
    }
    prev = snapshot
    if (deps.now().getTime() + intervalMs > end) break
    await sleep(intervalMs)
  }
  return exitCodeFor(worstSeen)
}

async function cmdLogs(deps: Deps, flags: Flags): Promise<number> {
  const { railway } = clients(deps)
  if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing")
  const now = deps.now()
  const since =
    parseSince(flags.since as string | undefined, now) ?? new Date(now.getTime() - 60 * 60_000).toISOString()
  const level = (flags.level as string | undefined) ?? "error"
  const service = flags.service as string | undefined
  const services = service ? [service] : [...PROD.logServices]
  const filterParts = [`(@level:${level})`, `(${services.map((name) => `@service:${name}`).join(" OR ")})`]
  if (flags.grep) filterParts.push(`(${flags.grep})`)
  const lines = await railway.environmentLogs({
    filter: filterParts.join(" AND "),
    after: since,
    limit: THRESHOLDS.logFetchLimit,
  })
  const templates = groupTemplates(lines)
  const truncated = lines.length >= THRESHOLDS.logFetchLimit
  if (flags.json) {
    console.log(
      JSON.stringify(
        { since, level, services, count: lines.length, truncated, templates, lines: flags.raw ? lines : undefined },
        null,
        2
      )
    )
    return 0
  }
  console.log(`${lines.length}${truncated ? "+" : ""} ${level} lines since ${since} across ${services.join(",")}`)
  for (const template of templates.slice(0, Number(flags.top ?? 15))) {
    console.log(
      `×${String(template.count).padEnd(4)} ${template.firstAt.slice(11, 19)}→${template.lastAt.slice(11, 19)} [${template.services.join(",")}]${template.noise ? ` (noise: ${template.noise})` : ""}\n      ${template.sample.slice(0, 300).replace(/\n/g, "\n      ")}`
    )
  }
  if (flags.raw)
    for (const line of lines) console.log(`${line.timestamp.slice(0, 19)} [${line.service}] ${line.message}`)
  return 0
}

async function cmdDeploys(deps: Deps, flags: Flags): Promise<number> {
  const { railway } = clients(deps)
  if (!railway) throw new Error("RAILWAY_READONLY_TOKEN missing")
  const deployments = await railway.listDeployments(Number(flags.top ?? 30))
  if (flags.json) {
    console.log(JSON.stringify(deployments, null, 2))
    return 0
  }
  for (const [service, { newest, serving }] of summarizeRailway(deployments)) {
    console.log(
      `${service.padEnd(14)} serving ${short(serving?.sha)} (${serving?.createdAt.slice(0, 16) ?? "?"})  newest ${newest.status} ${short(newest.sha)} ${newest.createdAt.slice(0, 16)}${newest.skippedReason ? ` (${newest.skippedReason})` : ""}`
    )
  }
  console.log("")
  for (const deployment of deployments) {
    console.log(
      `${deployment.createdAt.slice(0, 16)} ${deployment.service.padEnd(14)} ${deployment.status.padEnd(9)} ${short(deployment.sha)}  ${(deployment.commitMessage ?? "").split("\n")[0].slice(0, 70)}`
    )
  }
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
  const flags = values as Flags
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
