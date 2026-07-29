#!/usr/bin/env bun

import { adoptClaudeSession, adoptRefused } from "./adopt"
import {
  parseAdopt,
  parseBackfill,
  parseReconnect,
  parseResolve,
  parseResume,
  parseSpawn,
  parseTombstone,
  usage,
} from "./cli"
import {
  attachAgent,
  backfillIdentitiesCommand,
  bootResume,
  doctor,
  inferAndRun,
  installBootResumeAgent,
  interruptAgent,
  kickAgent,
  listAgents,
  resumeActive,
  sendKeysToAgent,
  spawnAgent,
  steerAgent,
  stopAgent,
  tombstoneCommand,
  reapArchived,
  watchUnarchived,
} from "./commands"
import { die } from "./errors"
import { resolveIdentity } from "./identity"
import { reconnectRuntime } from "./reconnect"

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv
  if (!command || command === "help" || command === "--help" || command === "-h") usage()
  if (command === "spawn") return spawnAgent(parseSpawn(args))
  if (command === "list") return listAgents()
  if (command === "reconnect") return reconnectRuntime(parseReconnect(args))
  if (command === "adopt" || command === "takeover") {
    const outcome = await adoptClaudeSession(parseAdopt(args))
    console.log(`${outcome.status}${outcome.detail ? `\t${outcome.detail}` : ""}`)
    if (adoptRefused(outcome.status)) process.exit(1)
    return
  }
  if (
    command === "up" ||
    command === "revive-unarchived" ||
    command === "resume-active" ||
    command === "restore-active"
  ) {
    await resumeActive(parseResume(args))
    return
  }
  if (command === "reap") return reapArchived({ dryRun: args.includes("--dry-run") })
  if (command === "watch-unarchived") return watchUnarchived(parseResume(args))
  if (command === "boot-resume") return bootResume(parseResume(args))
  if (command === "install-watch" || command === "install-boot-resume") {
    return installBootResumeAgent(parseResume(args))
  }
  if (command === "stop") return stopAgent(args[0] ?? die("stop requires an agent id or name"))
  if (command === "kick") return kickAgent(args[0] ?? die("kick requires an agent id, name, or runtime session id"))
  if (command === "interrupt") return interruptAgent(args[0] ?? die("interrupt requires an agent id or name"))
  if (command === "steer")
    return steerAgent(args[0] ?? die("steer requires an agent id or name"), args.slice(1).join(" "))
  if (command === "keys") return sendKeysToAgent(args[0] ?? die("keys requires an agent id or name"), args.slice(1))
  if (command === "attach") return attachAgent(args[0] ?? die("attach requires an agent id or name"))
  if (command === "resolve") return resolveIdentity(parseResolve(args))
  if (command === "backfill-identities") return backfillIdentitiesCommand(parseBackfill(args))
  if (command === "tombstone") return tombstoneCommand(parseTombstone(args))
  if (command === "doctor") return doctor()
  if (command === "do") return inferAndRun(args.join(" "))
  die(`unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`harnessd: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
