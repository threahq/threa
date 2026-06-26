#!/usr/bin/env bun

import { parseSpawn, usage } from "./cli"
import {
  attachAgent,
  doctor,
  inferAndRun,
  interruptAgent,
  listAgents,
  sendKeysToAgent,
  spawnAgent,
  steerAgent,
  stopAgent,
} from "./commands"
import { die } from "./errors"

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv
  if (!command || command === "help" || command === "--help" || command === "-h") usage()
  if (command === "spawn") return spawnAgent(parseSpawn(args))
  if (command === "list") return listAgents()
  if (command === "stop") return stopAgent(args[0] ?? die("stop requires an agent id or name"))
  if (command === "interrupt") return interruptAgent(args[0] ?? die("interrupt requires an agent id or name"))
  if (command === "steer")
    return steerAgent(args[0] ?? die("steer requires an agent id or name"), args.slice(1).join(" "))
  if (command === "keys") return sendKeysToAgent(args[0] ?? die("keys requires an agent id or name"), args.slice(1))
  if (command === "attach") return attachAgent(args[0] ?? die("attach requires an agent id or name"))
  if (command === "doctor") return doctor()
  if (command === "do") return inferAndRun(args.join(" "))
  die(`unknown command: ${command}`)
}

main().catch((error) => {
  console.error(`harnessd: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
