#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const SERVICE_NAME = "threa-hermes-remote.service"

export interface SystemdUnitInput {
  bunPath: string
  entryPath: string
  homeDir: string
  envFile: string
}

/** The unit text, modelled on the harnessd user unit: absolute paths, restart always, appended logs. */
export function renderSystemdUnit(input: SystemdUnitInput): string {
  for (const path of [input.bunPath, input.entryPath, input.homeDir, input.envFile]) {
    if (/[\s\\\0]/.test(path)) {
      throw new Error(
        `Cannot write a systemd unit for ${JSON.stringify(path)}: whitespace and backslashes need escaping systemd does not apply to every directive.`
      )
    }
  }
  const workingDir = dirname(dirname(input.entryPath))
  const logDir = join(input.homeDir, ".threa", "hermes-remote", "log")
  return [
    "[Unit]",
    "Description=Threa Hermes connector",
    "After=network-online.target hermes-gateway.service",
    "Wants=hermes-gateway.service",
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${dirname(input.bunPath)}:/usr/local/bin:/usr/bin:/bin`,
    `EnvironmentFile=-${input.envFile}`,
    `WorkingDirectory=${workingDir}`,
    `ExecStart=${input.bunPath} ${input.entryPath}`,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${join(logDir, "connector.log")}`,
    `StandardError=append:${join(logDir, "connector.error.log")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

export interface InstallOptions {
  homeDir: string
  packageDir: string
  bunPath: string
  force?: boolean
  start?: boolean
  dryRun?: boolean
  log?: (message: string) => void
  run?: (command: string, args: string[]) => { status: number | null }
}

export interface PlannedWrite {
  path: string
  /** Why this file is not written: an existing persona is never overwritten, an existing unit needs --force. */
  skipped?: string
}

export interface InstallPlan {
  unitPath: string
  unit: string
  directories: string[]
  writes: PlannedWrite[]
  commands: string[][]
}

function readPackageFile(packageDir: string, ...parts: string[]): string {
  return readFileSync(join(packageDir, ...parts), "utf8")
}

interface InstallFile {
  path: string
  content: () => string
  /** Set when an existing file is left alone; unset means it is always overwritten. */
  ifExists?: { keep: boolean; reason: string }
}

/** The one list both the plan and the install walk, so a dry run shows exactly what a real run does. */
function installFiles(options: InstallOptions, unitPath: string, unit: string): InstallFile[] {
  const { homeDir, packageDir } = options
  return [
    {
      path: unitPath,
      content: () => unit,
      ...(options.force
        ? {}
        : { ifExists: { keep: false, reason: "the unit already exists; pass --force to overwrite it" } }),
    },
    {
      path: join(homeDir, ".hermes", "skills", "threa", "SKILL.md"),
      content: () => readPackageFile(packageDir, "hermes", "skills", "threa", "SKILL.md"),
    },
    {
      path: join(homeDir, ".hermes", "SOUL.md"),
      content: () => readPackageFile(packageDir, "hermes", "SOUL.md"),
      ifExists: { keep: true, reason: "a persona already exists there and is never overwritten" },
    },
  ]
}

export function planInstall(options: InstallOptions): InstallPlan {
  const { homeDir, bunPath } = options
  const unitPath = join(homeDir, ".config", "systemd", "user", SERVICE_NAME)
  const unit = renderSystemdUnit({
    bunPath,
    entryPath: join(options.packageDir, "src", "index.ts"),
    homeDir,
    envFile: join(homeDir, ".config", "threa", "hermes-remote.env"),
  })
  const commands: string[][] = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", SERVICE_NAME],
  ]
  if (options.start) commands.push(["systemctl", "--user", "restart", SERVICE_NAME])
  return {
    unitPath,
    unit,
    directories: [
      dirname(unitPath),
      join(homeDir, ".threa", "hermes-remote", "log"),
      join(homeDir, ".hermes", "skills", "threa"),
    ],
    writes: installFiles(options, unitPath, unit).map((file) =>
      file.ifExists && existsSync(file.path) ? { path: file.path, skipped: file.ifExists.reason } : { path: file.path }
    ),
    commands,
  }
}

export function runInstall(options: InstallOptions): InstallPlan {
  const log = options.log ?? (() => {})
  const plan = planInstall(options)
  const unitWrite = plan.writes.find((write) => write.path === plan.unitPath)
  if (unitWrite?.skipped && !options.dryRun) {
    throw new Error(`${plan.unitPath} already exists. Pass --force to overwrite it.`)
  }

  for (const dir of plan.directories) {
    log(`${options.dryRun ? "would create" : "creating"} ${dir}`)
    if (!options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  for (const file of installFiles(options, plan.unitPath, plan.unit)) {
    const skipped = plan.writes.find((write) => write.path === file.path)?.skipped
    if (skipped) {
      log(`keeping ${file.path}: ${skipped}`)
      continue
    }
    log(`${options.dryRun ? "would write" : "writing"} ${file.path}`)
    if (options.dryRun) continue
    try {
      // Exclusive when an existing file matters: it may have appeared since the plan looked.
      writeFileSync(file.path, file.content(), { mode: 0o600, flag: file.ifExists ? "wx" : "w" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !file.ifExists) throw error
      if (!file.ifExists.keep) throw new Error(`${file.path} already exists. Pass --force to overwrite it.`)
      log(`keeping ${file.path}: ${file.ifExists.reason}`)
    }
  }
  const run = options.run ?? ((command, args) => spawnSync(command, args, { stdio: "inherit" }))
  for (const [command, ...args] of plan.commands) {
    if (!command) continue
    log(`${options.dryRun ? "would run" : "running"} ${[command, ...args].join(" ")}`)
    if (options.dryRun) continue
    const result = run(command, args)
    if (result.status !== 0) throw new Error(`${[command, ...args].join(" ")} exited with ${result.status}`)
  }
  return plan
}

const FLAGS = new Set(["--force", "--start", "--dry-run"])

function main(): void {
  const args = new Set(process.argv.slice(2))
  const unknown = [...args].filter((arg) => !FLAGS.has(arg))
  if (unknown.length > 0) {
    process.stderr.write(
      `Unknown argument ${unknown.join(" ")}. Usage: threa-hermes-install [--force] [--start] [--dry-run]\n`
    )
    process.exit(2)
  }
  if (process.platform !== "linux") {
    process.stderr.write(
      `threa-hermes-install only installs a systemd user unit, so it needs Linux (this is ${process.platform}). Run the connector with \`bun run start\` instead.\n`
    )
    process.exit(1)
  }
  const plan = runInstall({
    homeDir: homedir(),
    packageDir: dirname(dirname(fileURLToPath(import.meta.url))),
    bunPath: process.execPath,
    force: args.has("--force"),
    start: args.has("--start"),
    dryRun: args.has("--dry-run"),
    log: (message) => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(`unit: ${plan.unitPath}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`threa-hermes-install: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
