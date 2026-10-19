import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
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
  const unit = renderUserUnit({
    description: "Threa T3 Code connector",
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    workingDirectory: install.workDir,
    logDir: install.logDir,
    envFile: install.envFile,
  })
  for (const dir of [dirname(install.unitPath), install.workDir, install.logDir]) {
    log(`${verb("creating", "would create")} ${dir}`)
    if (!options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  log(`${verb("writing", "would write")} ${install.unitPath}`)
  if (!options.dryRun) {
    try {
      writeFileSync(install.unitPath, unit, { mode: 0o600, flag: options.force ? "w" : "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      throw new Error(`${install.unitPath} already exists. Pass --force to overwrite it.`)
    }
  }
  const run = options.run ?? ((command, args) => spawnSync(command, args, { stdio: "inherit" }))
  for (const [command, ...args] of userUnitCommands(install.serviceName, options.start ?? false)) {
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
  process.stdout.write(`unit: ${install.unitPath}\nenv file: ${install.envFile}\nlogs: ${install.logDir}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`threa-t3code-install: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
