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
// Stop work this long after the last confirmed renewal: one renew interval
// before the lease can expire, so a claim never runs past its server deadline.
const LEASE_UNCONFIRMED_LIMIT_MS = CLAIM_TTL_SECONDS * 1000 - Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
const STEP_FLUSH_MS = 1_000
const MAX_STEPS_PER_FLUSH = 50
// Trace is best effort: with the socket down every frame is an HTTP request,
// so the queue is bounded (oldest lines drop) and the end-of-turn flush gets a
// deadline rather than holding the reply.
const MAX_PENDING_STEPS = 500
const FINAL_FLUSH_DEADLINE_MS = 5_000

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
  // One drain at a time: a chatty command must not fan out into a socket frame
  // per 50 lines, and pushes while a drain runs only add to `pending`, never
  // another drain. `finished` stops the worker from picking up more.
  private draining: Promise<void> | undefined
  private finished = false

  constructor(
    private readonly send: (frames: StepFrame[]) => Promise<unknown>,
    private readonly options: { flushMs?: number; onError?: (error: unknown) => void } = {}
  ) {}

  /** Lines dropped because the queue was full; reported once through `onError` at the final flush. */
  dropped = 0

  push(line: string): void {
    if (this.finished) return
    if (this.pending.length >= MAX_PENDING_STEPS) {
      this.pending.shift()
      this.dropped += 1
    }
    this.pending.push({ stepType: "thinking", content: line.slice(0, 10_000) })
    if (this.pending.length >= MAX_STEPS_PER_FLUSH) void this.flush()
    else this.timer ??= setTimeout(() => void this.flush(), this.options.flushMs ?? STEP_FLUSH_MS)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.draining ??= (async () => {
      try {
        while (this.pending.length > 0 && !this.finished) {
          const frames = this.pending.splice(0, MAX_STEPS_PER_FLUSH)
          await this.send(frames).catch((error) => this.options.onError?.(error))
        }
      } finally {
        this.draining = undefined
      }
    })()
    return this.draining
  }

  /**
   * The end-of-turn flush. Whatever has not landed by the deadline is dropped
   * and reported; the one send still in flight completes on its own, nothing
   * else is started.
   */
  async finish(deadlineMs = FINAL_FLUSH_DEADLINE_MS): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    this.finished = true
    this.dropped += this.pending.length
    this.pending = []
    if (this.dropped > 0) this.options.onError?.(new Error(`${this.dropped} trace lines dropped`))
  }
}

/** The agent runs with the operator's environment minus the bot key: its stderr becomes visible trace. */
function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key !== "THREA_API_KEY"))
}

/** Own a scratchpad: every message there is a turn for the command; /stop kills it, /steer restarts it with the steer text. */
export async function runScratchpad(args: RunArgs, deps: RunDeps): Promise<void> {
  const config = resolveConfig(args, deps)
  const runtime = new CommandRuntime({
    command: args.command,
    cwd: deps.cwd,
    env: agentEnv(deps.env),
    timeoutMs: args.timeoutMs,
  })
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
        }).catch((error) =>
          deps.log(`turn ${turn.invocationId} failed: ${error instanceof Error ? error.message : error}`)
        )
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
    const steps = new StepBatcher((frames) => session.recordSteps(invocationId, frames), {
      onError: (error) => deps.log(`trace steps dropped: ${error instanceof Error ? error.message : error}`),
    })
    const outcome = await runtime.run(content, env, (line) => {
      steps.push(line)
      deps.log(`${name}: ${line}`)
    })
    await steps.finish()
    const reply = describeOutcome(outcome, args.command)
    if (reply === undefined) return
    const result = await session.reply(invocationId, reply)
    if (!result.ok) deps.log(`reply failed: ${result.message}`)
  }

  // Kill the agent command before the session closes its turns: the child is
  // in its own process group, so the signal that stops threa-bot never reaches it.
  wireLifecycle(
    {
      shutdown: async () => {
        await runtime.shutdown()
        await session.shutdown()
      },
    },
    process,
    { logPrefix: "[threa-bot]" }
  )
  await session.start()
}

/** Answer @mentions anywhere: claim, run the command, complete. No scratchpad, no session control. */
export async function runMentions(args: RunArgs, deps: RunDeps): Promise<void> {
  const config = resolveConfig(args, deps)
  const runtime = new CommandRuntime({
    command: args.command,
    cwd: deps.cwd,
    env: agentEnv(deps.env),
    timeoutMs: args.timeoutMs,
  })
  const client = new ThreaClient(config)
  const { instanceId } = config
  let draining = false
  let stopped = false
  let activeDrain: Promise<void> | undefined

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

  function drain(): Promise<void> {
    if (draining || stopped) return Promise.resolve()
    activeDrain = drainOnce().finally(() => {
      activeDrain = undefined
    })
    return activeDrain
  }

  async function drainOnce(): Promise<void> {
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
        if (stopped) {
          // Claimed while shutting down: hand it back rather than start work nobody will finish.
          await client
            .fail(invocation.id, {
              instanceId,
              claimToken: invocation.claimToken,
              errorMessage: "threa-bot shut down before the command started",
            })
            .catch(() => undefined)
          return
        }
        await presence("busy")
        // A claim the server no longer knows has nowhere to reply; stop the work.
        // The same goes for a lease the server has not confirmed recently: the
        // watchdog trips before the lease can expire (a renewal may itself
        // take the socket-ack plus HTTP timeouts), because after expiry another
        // runtime may already be running the same invocation.
        let claimLost = false
        let leaseConfirmedAt = Date.now()
        const loseClaim = (why: string) => {
          if (claimLost) return
          claimLost = true
          clearInterval(renew)
          clearInterval(watchdog)
          deps.log(`claim ${invocation.id} ${why}; stopping the command`)
          runtime.interrupt()
        }
        const renew = setInterval(
          async () => {
            const { notFound, renewed } = await transport.renewClaim(
              invocation.id,
              invocation.claimToken,
              CLAIM_TTL_SECONDS
            )
            if (notFound) loseClaim("lost (expired or reassigned)")
            else if (renewed) leaseConfirmedAt = Date.now()
          },
          Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
        )
        const watchdog = setInterval(() => {
          if (Date.now() - leaseConfirmedAt > LEASE_UNCONFIRMED_LIMIT_MS) loseClaim("lease unconfirmed too long")
        }, 5_000)
        try {
          const steps = new StepBatcher(
            (frames) =>
              transport.recordSteps(
                invocation.id,
                invocation.claimToken,
                frames,
                `Running ${basename(args.command[0]!)}…`
              ),
            { onError: (error) => deps.log(`trace steps dropped: ${error instanceof Error ? error.message : error}`) }
          )
          const outcome = await runtime.run(
            invocation.promptMarkdown,
            {
              THREA_INVOCATION_ID: invocation.id,
              THREA_STREAM_ID: invocation.responseStreamId,
              THREA_SOURCE_MESSAGE_ID: invocation.sourceMessageId,
            },
            (line) => {
              steps.push(line)
              deps.log(`${basename(args.command[0]!)}: ${line}`)
            }
          )
          await steps.finish()
          if (claimLost) continue
          if (stopped && !outcome.ok && outcome.reason === "interrupted") {
            // Shutdown cut the command; the mention is not answered, say so.
            await client.fail(invocation.id, {
              instanceId,
              claimToken: invocation.claimToken,
              errorMessage: "threa-bot shut down before the command finished",
            })
            return
          }
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
          clearInterval(watchdog)
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
    await runtime.shutdown()
    // Let the drain report the interrupted claim before the transport goes.
    if (activeDrain) {
      await Promise.race([activeDrain, new Promise((resolve) => setTimeout(resolve, FINAL_FLUSH_DEADLINE_MS))])
    }
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
