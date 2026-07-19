import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const LABEL = "io.threa.harnessd.resume-active"

export function installBootResume(tmux: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "install-boot-resume currently supports macOS LaunchAgents only; run boot-resume from your Linux startup service"
    )
  }
  const entrypointArg = process.argv[1]
  if (!entrypointArg) throw new Error("install-boot-resume: could not determine entrypoint path")
  const entrypoint = resolve(entrypointArg)
  const bun = process.execPath
  const logDir = join(homedir(), ".threa", "harnessd", "log")
  const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => key.startsWith("THREA_") && Boolean(value))
  ) as Record<string, string>
  writeFileSync(plist, launchAgentPlist({ bun, entrypoint, tmux, logDir, path: process.env.PATH ?? "", environment }))
  chmodSync(plist, 0o600)

  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("install-boot-resume: could not determine the current user id")
  const domain = `gui/${uid}`
  Bun.spawnSync(["launchctl", "bootout", domain, plist], { stdout: "ignore", stderr: "ignore" })
  const loaded = Bun.spawnSync(["launchctl", "bootstrap", domain, plist], { stdout: "pipe", stderr: "pipe" })
  if (loaded.exitCode !== 0) {
    throw new Error(loaded.stderr.toString().trim() || `launchctl bootstrap failed with exit code ${loaded.exitCode}`)
  }

  console.log(`harnessd: installed and started ${LABEL}; watching unarchived agents in tmux session '${tmux}'`)
}

export function launchAgentPlist(params: {
  bun: string
  entrypoint: string
  tmux: string
  logDir: string
  path: string
  environment: Record<string, string>
}): string {
  const command = `sleep 15; exec ${shellQuote(params.bun)} ${shellQuote(params.entrypoint)} watch-unarchived --tmux ${shellQuote(params.tmux)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>${xmlEscape(command)}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(params.path)}</string>${Object.entries(
    params.environment
  )
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join("")}</dict>
<key>StandardOutPath</key><string>${xmlEscape(join(params.logDir, "resume-active.log"))}</string>
<key>StandardErrorPath</key><string>${xmlEscape(join(params.logDir, "resume-active.error.log"))}</string>
</dict></plist>
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
