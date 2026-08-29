import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { basename } from "node:path"
import { BotRuntimeTransport, type StepFrame } from "@threahq/bot-runtime-client"
import {
  RemoteSession,
  ThreaClient,
  loadConfig,
  parseConfigFile,
  wireLifecycle,
  type RemoteSessionConfig,
} from "@threahq/remote-session"
import type { RunArgs } from "./args"
import { CommandRuntime, describeOutcome } from "./command-runtime"

const MENTION_RUNTIME_KIND = "custom"
const MENTION_POLL_MS = 30_000
const MENTION_PRESENCE_MS = 20_000
const CLAIM_TTL_SECONDS = 120
const STEP_FLUSH_MS = 1_000
const MAX_STEPS_PER_FLUSH = 50

export interface RunDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  log: (line: string) => void
}

export function resolveConfig(args: RunArgs, deps: RunDeps): RemoteSessionConfig {
  const file = args.config ? parseConfigFile(readFileSync(args.config, "utf8")) : undefined
  const prefix = args.name ?? basename(args.command[0] ?? "bot")
  const loaded = loadConfig(
    { env: deps.env, cwd: deps.cwd, hostname: hostname(), ...(file ? { file } : {}) },
    { idPrefix: "bot", sessionIdPrefix: "bots", displayNamePrefix: prefix, configPathHint: args.config }
  )
  if ("error" in loaded) throw new Error(loaded.error)
  return loaded.config
}

/**
 * Batches a command's stderr lines into trace steps: one frame per line, at
 * most one flush a second, so a chatty agent does not fire a socket frame per
 * line while a quiet one still shows up promptly.
 */
export class StepBatcher {
  private pending: StepFrame[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly send: (frames: StepFrame[]) => Promise<unknown>,
    private readonly flushMs = STEP_FLUSH_MS
  ) {}

  push(line: string): void {
    this.pending.push({ stepType: "thinking", content: line.slice(0, 10_000) })
    if (this.pending.length >= MAX_STEPS_PER_FLUSH) void this.flush()
    else this.timer ??= setTimeout(() => void this.flush(), this.flushMs)
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const frames = this.pending.splice(0, MAX_STEPS_PER_FLUSH)
    if (frames.length > 0) await this.send(frames).catch(() => undefined)
    if (this.pending.length > 0) await this.flush()
  }
}

/** Own a scratchpad: every message there is a turn for the command; /stop kills it, /steer restarts it with the steer text. */
export async function runScratchpad(args: RunArgs, deps: RunDeps): Promise<void> {
  const config = resolveConfig(args, deps)
  const runtime = new CommandRuntime({ command: args.command, cwd: deps.cwd, env: deps.env, timeoutMs: args.timeoutMs })
  const client = new ThreaClient(config)
  const name = basename(args.command[0]!)
  const session = new RemoteSession({
    config,
    client,
    runtime: {
      kind: MENTION_RUNTIME_KIND,
      manifest: { output: { reply: true, trace: true, sources: false } },
      busyStatusText: `Running ${name}…`,
      forwardedNote: `Forwarded to ${name}.`,
      shutdownErrorMessage: "threa-bot shut down",
    },
    delegate: {
      deliverTurn: async (turn) => {
        // Resolve on hand-off; the reply lands when the command exits.
        void execute(turn.invocationId, turn.content, {
          THREA_INVOCATION_ID: turn.invocationId,
          THREA_STREAM_ID: turn.streamId,
          THREA_SOURCE_MESSAGE_ID: turn.sourceMessageId,
        })
      },
      sessionControl: {
        commands: ["stop", "steer"],
        interrupt: () => runtime.interrupt(),
        runCommand: async (command) => ({ ok: false, message: `Unsupported command: /${command}` }),
      },
      onLinked: (link) => deps.log(`scratchpad: ${config.baseUrl}${link.streamUrlPath}`),
    },
    log: deps.log,
  })

  async function execute(invocationId: string, content: string, env: Record<string, string>): Promise<void> {
    const steps = new StepBatcher((frames) => session.recordSteps(invocationId, frames))
    runtime.onStderrLine = (line) => {
      steps.push(line)
      deps.log(`${name}: ${line}`)
    }
    const outcome = await runtime.run(content, env)
    await steps.flush()
    const reply = describeOutcome(outcome, args.command)
    if (reply === undefined) return
    const result = await session.reply(invocationId, reply)
    if (!result.ok) deps.log(`reply failed: ${result.message}`)
  }

  wireLifecycle(session, process, { logPrefix: "[threa-bot]" })
  await session.start()
}

/** Answer @mentions anywhere: claim, run the command, complete. No scratchpad, no session control. */
export async function runMentions(args: RunArgs, deps: RunDeps): Promise<void> {
  const config = resolveConfig(args, deps)
  const runtime = new CommandRuntime({ command: args.command, cwd: deps.cwd, env: deps.env, timeoutMs: args.timeoutMs })
  const client = new ThreaClient(config)
  const { instanceId } = config
  let draining = false
  let stopped = false

  const transport = new BotRuntimeTransport({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
    hello: {
      instanceId,
      runtimeKind: MENTION_RUNTIME_KIND,
      displayName: config.displayName,
      supportedCapabilities: ["mentionable"],
      manifest: { output: { reply: true, trace: true, sources: false } },
    },
    callbacks: { onInvocationAvailable: () => void drain(), onBootstrap: () => void drain() },
    log: deps.log,
  })
  const presence = (status: "available" | "busy" | "offline") =>
    transport.updatePresence({
      runtimeKind: MENTION_RUNTIME_KIND,
      instanceId,
      displayName: config.displayName,
      status,
      acceptingInvocations: status !== "offline",
      capabilities: {},
    })

  async function drain(): Promise<void> {
    if (draining || stopped) return
    draining = true
    try {
      while (!stopped) {
        const invocation = await client.claim({
          runtimeKind: MENTION_RUNTIME_KIND,
          instanceId,
          supportedCapabilities: ["mentionable"],
          claimTtlSeconds: CLAIM_TTL_SECONDS,
        })
        if (!invocation) return
        await presence("busy")
        const renew = setInterval(
          () => void transport.renewClaim(invocation.id, invocation.claimToken, CLAIM_TTL_SECONDS),
          Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
        )
        try {
          const steps = new StepBatcher((frames) =>
            transport.recordSteps(
              invocation.id,
              invocation.claimToken,
              frames,
              `Running ${basename(args.command[0]!)}…`
            )
          )
          runtime.onStderrLine = (line) => {
            steps.push(line)
            deps.log(`${basename(args.command[0]!)}: ${line}`)
          }
          const outcome = await runtime.run(invocation.promptMarkdown, {
            THREA_INVOCATION_ID: invocation.id,
            THREA_STREAM_ID: invocation.responseStreamId,
            THREA_SOURCE_MESSAGE_ID: invocation.sourceMessageId,
          })
          await steps.flush()
          const reply = describeOutcome(outcome, args.command) ?? "Stopped."
          await client.complete(invocation.id, {
            instanceId,
            claimToken: invocation.claimToken,
            finalMessageMarkdown: reply,
          })
        } catch (error) {
          await client
            .fail(invocation.id, {
              instanceId,
              claimToken: invocation.claimToken,
              errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
            })
            .catch((failure) => deps.log(`fail() failed: ${failure instanceof Error ? failure.message : failure}`))
        } finally {
          clearInterval(renew)
          if (!stopped) await presence("available")
        }
      }
    } catch (error) {
      deps.log(`claim loop: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      draining = false
    }
  }

  const shutdown = async (): Promise<void> => {
    stopped = true
    clearInterval(backstop)
    clearInterval(heartbeat)
    runtime.interrupt()
    transport.disconnect()
    await presence("offline").catch(() => undefined)
  }
  wireLifecycle({ shutdown }, process, { logPrefix: "[threa-bot]" })

  await presence("available")
  await transport.connect()
  deps.log(`answering @mentions as ${config.displayName} (${instanceId})`)
  const backstop = setInterval(() => void drain(), MENTION_POLL_MS)
  const heartbeat = setInterval(() => void presence(runtime.busy ? "busy" : "available"), MENTION_PRESENCE_MS)
  await drain()
}
