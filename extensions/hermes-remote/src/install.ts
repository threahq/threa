import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hermesInstall, type HermesInstall } from "./config"

export interface SystemdUnitInput {
  /** The runtime the unit execs: bun from a checkout, node from an npm install. */
  runtimePath: string
  entryPath: string
  packageDir: string
  logDir: string
  envFile: string
  /** The Hermes profile this unit serves; unset is the default one. */
  profile?: string
}

/** The unit text, modelled on the harnessd user unit: absolute paths, restart always, appended logs. */
export function renderSystemdUnit(input: SystemdUnitInput): string {
  for (const path of [input.runtimePath, input.entryPath, input.packageDir, input.logDir, input.envFile]) {
    if (/[\s\\\0]/.test(path)) {
      throw new Error(
        `Cannot write a systemd unit for ${JSON.stringify(path)}: whitespace and backslashes need escaping systemd does not apply to every directive.`
      )
    }
  }
  return [
    "[Unit]",
    `Description=Threa Hermes connector${input.profile ? ` (${input.profile})` : ""}`,
    "After=network-online.target hermes-gateway.service",
    "Wants=hermes-gateway.service",
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${dirname(input.runtimePath)}:/usr/local/bin:/usr/bin:/bin`,
    `EnvironmentFile=-${input.envFile}`,
    // After the env file on purpose: the profile is what this unit IS, and an
    // env file shared between agents must not be able to repoint it.
    ...(input.profile ? [`Environment=THREA_HERMES_PROFILE=${input.profile}`] : []),
    `WorkingDirectory=${input.packageDir}`,
    `ExecStart=${input.runtimePath} ${input.entryPath}`,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${join(input.logDir, "connector.log")}`,
    `StandardError=append:${join(input.logDir, "connector.error.log")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

export interface InstallOptions {
  install: HermesInstall
  packageDir: string
  entryPath: string
  runtimePath: string
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

/**
 * The skill tells the agent where its work dir and MCP config are, and the
 * shipped copy names the default install's. A profile's copy names its own, so
 * a named agent is not sent to another agent's files.
 */
function forInstall(text: string, install: HermesInstall): string {
  return text.replaceAll("~/.threa/hermes-remote", `~/.threa/${basename(install.configDir)}`)
}

interface InstallFile {
  path: string
  content: () => string
  /** Set when an existing file is left alone; unset means it is always overwritten. */
  ifExists?: { keep: boolean; reason: string }
}

/** The one list both the plan and the install walk, so a dry run shows exactly what a real run does. */
function installFiles(options: InstallOptions, unit: string): InstallFile[] {
  const { install, packageDir } = options
  return [
    {
      path: install.unitPath,
      content: () => unit,
      ...(options.force
        ? {}
        : { ifExists: { keep: false, reason: "the unit already exists; pass --force to overwrite it" } }),
    },
    {
      path: join(install.hermesHome, "skills", "threa", "SKILL.md"),
      content: () => forInstall(readPackageFile(packageDir, "hermes", "skills", "threa", "SKILL.md"), install),
    },
    {
      path: join(install.hermesHome, "SOUL.md"),
      content: () => readPackageFile(packageDir, "hermes", "SOUL.md"),
      ifExists: { keep: true, reason: "a persona already exists there and is never overwritten" },
    },
  ]
}

export function planInstall(options: InstallOptions): InstallPlan {
  const { install } = options
  const unit = renderSystemdUnit({
    runtimePath: options.runtimePath,
    entryPath: options.entryPath,
    packageDir: options.packageDir,
    logDir: install.logDir,
    envFile: install.envFile,
    ...(install.profile === undefined ? {} : { profile: install.profile }),
  })
  const commands: string[][] = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", install.serviceName],
  ]
  if (options.start) commands.push(["systemctl", "--user", "restart", install.serviceName])
  return {
    unitPath: install.unitPath,
    unit,
    directories: [dirname(install.unitPath), install.logDir, join(install.hermesHome, "skills", "threa")],
    writes: installFiles(options, unit).map((file) =>
      file.ifExists && existsSync(file.path) ? { path: file.path, skipped: file.ifExists.reason } : { path: file.path }
    ),
    commands,
  }
}

export function runInstall(options: InstallOptions): InstallPlan {
  const log = options.log ?? (() => {})
  const { install } = options
  // A named profile's home is Hermes's to create: writing a persona and a skill
  // into a directory `hermes profile list` knows nothing about would look
  // installed and never run.
  if (install.profile && !existsSync(install.hermesHome)) {
    throw new Error(
      `Hermes profile "${install.profile}" has no home at ${install.hermesHome}. ` +
        `Create it first: hermes profile create ${install.profile}`
    )
  }
  const plan = planInstall(options)
  const unitWrite = plan.writes.find((write) => write.path === plan.unitPath)
  if (unitWrite?.skipped && !options.dryRun) {
    throw new Error(`${plan.unitPath} already exists. Pass --force to overwrite it.`)
  }

  for (const dir of plan.directories) {
    log(`${options.dryRun ? "would create" : "creating"} ${dir}`)
    if (!options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  for (const file of installFiles(options, plan.unit)) {
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
const USAGE = "threa-hermes-install [--profile <name>] [--force] [--start] [--dry-run]"

export interface ParsedArgs {
  profile?: string
  force: boolean
  start: boolean
  dryRun: boolean
}

/** `--profile` takes a value, so the arguments are walked rather than set-tested. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>()
  let profile: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === "--profile") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`--profile needs a Hermes profile name. Usage: ${USAGE}`)
      }
      profile = value
      index += 1
      continue
    }
    if (arg.startsWith("--profile=")) {
      profile = arg.slice("--profile=".length)
      if (profile.length === 0) throw new Error(`--profile needs a Hermes profile name. Usage: ${USAGE}`)
      continue
    }
    if (!FLAGS.has(arg)) throw new Error(`Unknown argument ${arg}. Usage: ${USAGE}`)
    flags.add(arg)
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    force: flags.has("--force"),
    start: flags.has("--start"),
    dryRun: flags.has("--dry-run"),
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (process.platform !== "linux") {
    process.stderr.write(
      `threa-hermes-install only installs a systemd user unit, so it needs Linux (this is ${process.platform}). Run the connector with \`threa-hermes\` instead.\n`
    )
    process.exit(1)
  }
  // From a checkout this file is src/install.ts beside src/index.ts; the npm
  // package bundles both to its root as .js.
  const here = dirname(fileURLToPath(import.meta.url))
  const fromSource = import.meta.url.endsWith(".ts")
  const entryPath = join(here, fromSource ? "index.ts" : "index.js")
  if (entryPath.includes("/_npx/")) {
    process.stderr.write(
      "threa-hermes-install is running from npx's cache, which npm clears, and the unit would point into it. Install the package first: npm install -g @threahq/hermes-remote\n"
    )
    process.exit(1)
  }
  const install = hermesInstall({
    homeDir: homedir(),
    ...(args.profile === undefined ? {} : { profile: args.profile }),
  })
  runInstall({
    install,
    packageDir: fromSource ? dirname(here) : here,
    entryPath,
    runtimePath: process.execPath,
    force: args.force,
    start: args.start,
    dryRun: args.dryRun,
    log: (message) => process.stdout.write(`${message}\n`),
  })
  process.stdout.write(`unit: ${install.unitPath}\n`)
  process.stdout.write(`env file: ${install.envFile}\n`)
  process.stdout.write(`gateway (unless HERMES_API_URL says otherwise): ${install.hermesApiUrl}\n`)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`threa-hermes-install: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
