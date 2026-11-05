import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { connectorEntry, renderUserUnit, userUnitCommands } from "@threahq/remote-session"
import { t3Install, type T3Install } from "./config"

export interface InstallOptions {
  install: T3Install
  entryPath: string
  runtimePath: string
  force?: boolean
  start?: boolean
  dryRun?: boolean
  log?: (message: string) => void
  run?: (command: string, args: string[]) => { status: number | null }
}

export function runInstall(options: InstallOptions): void {
  const { install } = options
  const log = options.log ?? (() => {})
  const verb = (doing: string, would: string) => (options.dryRun ? would : doing)
  const common = {
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    workingDirectory: install.workDir,
    logDir: install.logDir,
    envFile: install.envFile,
  }
  const units = [
    {
      path: install.unitPath,
      // Pinned, not left to the env file: each connector's unit name is its own, and naming it is what lets an
      // archived scratchpad hibernate the unit for the waker to start again.
      content: renderUserUnit({
        ...common,
        description: "Threa T3 Code connector",
        pinnedEnvironment: { THREA_T3CODE_UNIT: "%n" },
      }),
    },
    {
      path: install.wakeUnitPath,
      content: renderUserUnit({
        ...common,
        description: "Threa T3 Code connector waker",
        args: ["wake"],
        logName: "wake",
      }),
    },
  ]
  for (const dir of [dirname(install.unitPath), install.workDir, install.logDir]) {
    log(`${verb("creating", "would create")} ${dir}`)
    if (!options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  if (!options.force && !options.dryRun) {
    const existing = units.find((unit) => existsSync(unit.path))
    if (existing) throw new Error(`${existing.path} already exists. Pass --force to overwrite it.`)
  }
  for (const unit of units) {
    log(`${verb("writing", "would write")} ${unit.path}`)
    if (!options.dryRun) writeFileSync(unit.path, unit.content, { mode: 0o600 })
  }
  const run = options.run ?? ((command, args) => spawnSync(command, args, { stdio: "inherit" }))
  for (const [command, ...args] of userUnitCommands(
    [install.serviceName, install.wakeServiceName],
    options.start ?? false
  )) {
    const line = [command, ...args].join(" ")
    log(`${verb("running", "would run")} ${line}`)
    if (options.dryRun) continue
    const result = run(command!, args)
    if (result.status !== 0) throw new Error(`${line} exited with ${result.status}`)
  }
}

const FLAGS = ["--force", "--start", "--dry-run"] as const
const USAGE = `threa-t3code-install [${FLAGS.join("] [")}]`

export function parseArgs(argv: string[]): { force: boolean; start: boolean; dryRun: boolean } {
  const unknown = argv.find((arg) => !FLAGS.includes(arg as (typeof FLAGS)[number]))
  if (unknown !== undefined) throw new Error(`Unknown argument ${unknown}. Usage: ${USAGE}`)
  return { force: argv.includes("--force"), start: argv.includes("--start"), dryRun: argv.includes("--dry-run") }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (process.platform !== "linux") {
    throw new Error(
      `it only installs a systemd user unit, so it needs Linux (this is ${process.platform}). Run the connector with \`threa-t3code\` instead.`
    )
  }
  const install = t3Install()
  runInstall({
    install,
    entryPath: connectorEntry(import.meta.url, "@threahq/t3code-remote").entryPath,
    runtimePath: process.execPath,
    ...args,
    log: (message) => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(
    `units: ${install.unitPath} ${install.wakeUnitPath}\nenv file: ${install.envFile}\nlogs: ${install.logDir}\n`
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`threa-t3code-install: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
