#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { ThreaClient, parseConfigFile, wireLifecycle, type RawConfig } from "@threa/remote-session"
import { isChannelLaunch, readParentCommand } from "./channel-detect"
import { CHANNEL_SOURCE, ChannelServer } from "./channel-server"
import { CONFIG_PATH, loadChannelConfig } from "./config"

function readFileConfig(): RawConfig | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    return parseConfigFile(readFileSync(CONFIG_PATH, "utf8"))
  } catch (error) {
    process.stderr.write(
      `[threa-channel] ignoring ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return undefined
  }
}

async function main(): Promise<void> {
  const result = loadChannelConfig({
    env: process.env,
    cwd: process.cwd(),
    hostname: hostname(),
    file: readFileConfig(),
  })
  if ("error" in result) {
    process.stderr.write(`[threa-channel] ${result.error}\n`)
    process.exit(1)
  }

  // The user-scope `threa` registration loads this server in EVERY Claude
  // session, channel or not. Only a session Claude Code actually treats as a
  // channel may link a scratchpad — see channel-detect.ts for why the parent
  // process's launch flag is the only observable (and authoritative) signal.
  const parentCommand = readParentCommand(process.ppid)
  const channelActive = isChannelLaunch(parentCommand, CHANNEL_SOURCE)

  const client = new ThreaClient(result.config)
  const server = new ChannelServer(result.config, client, undefined, channelActive)

  // Connect stdio first so Claude Code registers the channel and discovers the
  // reply tool even while the Threa bridge is still spinning up. This also puts
  // stdin in flowing mode, so the parent-death end/close events below fire.
  await server.connectStdio()

  // Route every way the process can die (signals, parent exit, steady-state
  // throws) through one graceful teardown — Claude Code never respawns a dead
  // stdio MCP server mid-session, so a silent drop strands the scratchpad as
  // "busy" with nobody to answer until a human restarts.
  wireLifecycle(server, process, { logPrefix: "[threa-channel]" })

  if (!channelActive) {
    process.stderr.write(
      `[threa-channel] parent Claude session did not load this server as a channel ` +
        `(--dangerously-load-development-channels server:${CHANNEL_SOURCE} absent from: ${parentCommand || "<unreadable>"}) — ` +
        `serving as a plain MCP server; no scratchpad linked\n`
    )
    return
  }

  // start() is best-effort internally (link/socket/presence self-heal on the
  // poll loop); an error escaping it is an unexpected init failure, so fail loud
  // — let it propagate to main().catch below, which logs and exits non-zero
  // rather than leaving a connected-but-dead channel Claude can't detect.
  await server.start()
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[threa-channel] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
