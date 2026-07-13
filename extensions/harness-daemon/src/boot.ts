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

  console.log(`harnessd: installed ${LABEL}; it will resume agents in tmux session '${tmux}' at the next login`)
}

export function launchAgentPlist(params: {
  bun: string
  entrypoint: string
  tmux: string
  logDir: string
  path: string
  environment: Record<string, string>
}): string {
  const command = `sleep 15; exec ${shellQuote(params.bun)} ${shellQuote(params.entrypoint)} boot-resume --tmux ${shellQuote(params.tmux)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>${xmlEscape(command)}</string></array>
<key>RunAtLoad</key><true/>
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
