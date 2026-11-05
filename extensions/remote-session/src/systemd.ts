import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface UserUnitInput {
  description: string
  /** The runtime the unit execs: bun from a checkout, node from an npm install. */
  runtimePath: string
  entryPath: string
  /** Arguments after the entry, e.g. a subcommand. */
  args?: string[]
  workingDirectory: string
  logDir: string
  /** Log file stem under `logDir`; defaults to `connector`. */
  logName?: string
  envFile: string
  /** Services this one starts after and pulls in. */
  wants?: string[]
  /**
   * Pinned on the command line through env(1): systemd lets an EnvironmentFile
   * override `Environment=`, and an env file shared between connectors must not repoint these.
   */
  pinnedEnvironment?: Record<string, string>
}

/** A connector's systemd user unit: absolute paths, restart always, logs appended under `logDir`. */
export function renderUserUnit(input: UserUnitInput): string {
  for (const value of [
    input.runtimePath,
    input.entryPath,
    input.workingDirectory,
    input.logDir,
    input.envFile,
    ...Object.values(input.pinnedEnvironment ?? {}),
    ...(input.args ?? []),
  ]) {
    if (/[\s\\\0]/.test(value)) {
      throw new Error(
        `Cannot write a systemd unit for ${JSON.stringify(value)}: whitespace and backslashes need escaping systemd does not apply to every directive.`
      )
    }
  }
  const wants = input.wants ?? []
  const logName = input.logName ?? "connector"
  const pinned = Object.entries(input.pinnedEnvironment ?? {}).map(([name, value]) => `${name}=${value}`)
  if (pinned.length > 0) pinned.unshift("/usr/bin/env")
  return [
    "[Unit]",
    `Description=${input.description}`,
    `After=${["network-online.target", ...wants].join(" ")}`,
    ...(wants.length > 0 ? [`Wants=${wants.join(" ")}`] : []),
    "",
    "[Service]",
    "Type=simple",
    `Environment=PATH=${dirname(input.runtimePath)}:/usr/local/bin:/usr/bin:/bin`,
    `EnvironmentFile=-${input.envFile}`,
    `WorkingDirectory=${input.workingDirectory}`,
    `ExecStart=${[...pinned, input.runtimePath, input.entryPath, ...(input.args ?? [])].join(" ")}`,
    "Restart=always",
    "RestartSec=10",
    `StandardOutput=append:${join(input.logDir, `${logName}.log`)}`,
    `StandardError=append:${join(input.logDir, `${logName}.error.log`)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

/** A single name stays accepted: published connectors on `^0.3` still pass one. */
export function userUnitCommands(serviceNames: string | string[], start: boolean): string[][] {
  const names = typeof serviceNames === "string" ? [serviceNames] : serviceNames
  return [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", ...names],
    ...(start ? [["systemctl", "--user", "restart", ...names]] : []),
  ]
}

/**
 * Where an installer's connector entry lives. From a checkout the installer is
 * `src/install.ts` beside `src/index.ts`; an npm package bundles both to its root as `.js`.
 */
export function connectorEntry(installerUrl: string, packageName: string): { entryPath: string; packageDir: string } {
  const here = dirname(fileURLToPath(installerUrl))
  const fromSource = installerUrl.endsWith(".ts")
  const entryPath = join(here, fromSource ? "index.ts" : "index.js")
  if (entryPath.includes("/_npx/")) {
    throw new Error(
      `This installer is running from npx's cache, which npm clears, and the unit would point into it. Install the package first: npm install -g ${packageName}`
    )
  }
  return { entryPath, packageDir: fromSource ? dirname(here) : here }
}
