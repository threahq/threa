import { hostname } from "node:os"
import { ThreaClient, readConfigFile, wireLifecycle } from "@threahq/remote-session"
import { channelActivation, launchedWithSettings, readParentCommand } from "./channel-detect"
import { ChannelServer } from "./channel-server"
import { CONFIG_PATH, loadChannelConfig } from "./config"
import { StopHookListener } from "./stop-hook-listener"

function logStderr(message: string): void {
  process.stderr.write(`[threa-channel] ${message}\n`)
}

/** Listen for Claude's Stop hook when harnessd launched Claude with the hook settings; otherwise `reply` closes turns. */
async function openStopHooks(parentCommand: string): Promise<StopHookListener | undefined> {
  const socket = process.env.THREA_CHANNEL_HOOK_SOCKET
  const settings = process.env.THREA_CHANNEL_HOOK_SETTINGS
  if (!socket) return undefined
  if (!settings || !launchedWithSettings(parentCommand, settings)) {
    logStderr(`Claude was not launched with the stop-hook settings (${settings ?? "<unset>"}) — turns close on reply`)
    return undefined
  }
  try {
    return await StopHookListener.listen(socket, logStderr)
  } catch (error) {
    logStderr(
      `stop hook: cannot listen on ${socket} (${error instanceof Error ? error.message : String(error)}) — turns close on reply`
    )
    return undefined
  }
}

async function main(): Promise<void> {
  const result = loadChannelConfig({
    env: process.env,
    cwd: process.cwd(),
    hostname: hostname(),
    file: readConfigFile(CONFIG_PATH, logStderr),
  })
  if ("error" in result) {
    logStderr(result.error)
    process.exit(1)
  }

  // A user-scope registration loads this server in EVERY Claude session,
  // channel or not — and one session can load several registrations of this
  // same script. Only the instance whose OWN registration key is named in the
  // launch flag may link the scratchpad; the key reaches us via
  // THREA_CHANNEL_SERVER_KEY on the registration (see channel-detect.ts for
  // why no other signal can tell the instances apart).
  const serverKey = process.env.THREA_CHANNEL_SERVER_KEY
  const parentCommand = readParentCommand(process.ppid)
  const activation = channelActivation(parentCommand, serverKey)

  const client = new ThreaClient(result.config)
  // MCP instructions are fixed when stdio connects, so hook mode is settled before the server exists.
  const stopHooks = activation.active ? await openStopHooks(parentCommand) : undefined
  const server = new ChannelServer(result.config, client, undefined, activation.active, undefined, stopHooks)

  // Connect stdio first so Claude Code registers the channel and discovers the
  // reply tool even while the Threa bridge is still spinning up. This also puts
  // stdin in flowing mode, so the parent-death end/close events below fire.
  await server.connectStdio()

  // Route every way the process can die (signals, parent exit, steady-state
  // throws) through one graceful teardown — Claude Code never respawns a dead
  // stdio MCP server mid-session, so a silent drop strands the scratchpad as
  // "busy" with nobody to answer until a human restarts.
  wireLifecycle(server, process, { logPrefix: "[threa-channel]" })

  if (!activation.active) {
    const detail =
      activation.reason === "no-server-key"
        ? `registration carries no THREA_CHANNEL_SERVER_KEY — add "env": {"THREA_CHANNEL_SERVER_KEY": "<registered server name>"} to this server's MCP registration to enable channel mode`
        : `--dangerously-load-development-channels server:${serverKey} absent from: ${parentCommand || "<unreadable>"}`
    process.stderr.write(
      `[threa-channel] parent Claude session did not load this server as a channel (${detail}) — ` +
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
