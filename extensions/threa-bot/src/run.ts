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
// Stop work this long before the lease's server-side expiry (one renew
// interval), so a claim never runs past the point another runtime could take it.
const LEASE_SAFETY_MS = Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
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
  private readonly pending = new Map<string, StepFrame[]>()
  private readonly senders = new Map<string, (frames: StepFrame[]) => Promise<unknown>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  // One drain for the whole process: with the socket down each frame is an
  // HTTP request, so a turn that leaves a send stuck must not let the next
  // turn start another. Pushes only add to `pending`; `finish` drops a turn's
  // leftovers at its deadline and closes it to further lines.
  private draining: Promise<void> | undefined

  constructor(
    private readonly options: { flushMs?: number; onError?: (invocationId: string, error: unknown) => void } = {}
  ) {}

  /** Lines dropped for a full queue or a missed deadline, per turn; reported once through `onError` at `finish`. */
  readonly dropped = new Map<string, number>()

  begin(invocationId: string, send: (frames: StepFrame[]) => Promise<unknown>): void {
    this.senders.set(invocationId, send)
    this.pending.set(invocationId, [])
    this.dropped.set(invocationId, 0)
  }

  push(invocationId: string, line: string): void {
    const queue = this.pending.get(invocationId)
    if (!queue) return
    if (queue.length >= MAX_PENDING_STEPS) {
      queue.shift()
      this.dropped.set(invocationId, (this.dropped.get(invocationId) ?? 0) + 1)
    }
    queue.push({ stepType: "thinking", content: line.slice(0, 10_000) })
    if (queue.length >= MAX_STEPS_PER_FLUSH) void this.flush()
    else this.timer ??= setTimeout(() => void this.flush(), this.options.flushMs ?? STEP_FLUSH_MS)
  }

  private nextBatch(): { invocationId: string; frames: StepFrame[] } | undefined {
    for (const [invocationId, queue] of this.pending) {
      if (queue.length > 0) return { invocationId, frames: queue.splice(0, MAX_STEPS_PER_FLUSH) }
    }
    return undefined
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.draining ??= (async () => {
      try {
        for (let batch = this.nextBatch(); batch; batch = this.nextBatch()) {
          const send = this.senders.get(batch.invocationId)
          if (!send) continue
          await send(batch.frames).catch((error) => this.options.onError?.(batch!.invocationId, error))
        }
      } finally {
        this.draining = undefined
      }
    })()
    return this.draining
  }

  /**
   * The end of a turn: wait for its lines to go out, up to the deadline; what
   * has not gone by then is dropped and reported, and the turn takes no more.
   * A send still in flight (this turn's or an earlier one's) finishes on its
   * own; nothing new starts for this turn.
   */
  async finish(invocationId: string, deadlineMs = FINAL_FLUSH_DEADLINE_MS): Promise<void> {
    const queue = this.pending.get(invocationId)
    if (!queue) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const drained = (async () => {
      while (queue.length > 0) await this.flush()
    })()
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, deadlineMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    const dropped = (this.dropped.get(invocationId) ?? 0) + queue.length
    this.pending.delete(invocationId)
    this.senders.delete(invocationId)
    this.dropped.delete(invocationId)
    if (dropped > 0) this.options.onError?.(invocationId, new Error(`${dropped} trace lines dropped`))
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
  const steps = new StepBatcher({
    onError: (invocationId, error) =>
      deps.log(`trace for ${invocationId}: ${error instanceof Error ? error.message : error}`),
  })
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
    steps.begin(invocationId, (frames) => session.recordSteps(invocationId, frames))
    const outcome = await runtime.run(content, env, (line) => {
      steps.push(invocationId, line)
      deps.log(`${name}: ${line}`)
    })
    await steps.finish(invocationId)
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
  // Which claim owns the running command: a renewal that resolves late, after
  // its own turn ended, must not interrupt the next one.
  let turnGeneration = 0
  const steps = new StepBatcher({
    onError: (invocationId, error) =>
      deps.log(`trace for ${invocationId}: ${error instanceof Error ? error.message : error}`),
  })

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
        const turn = ++turnGeneration
        // A claim the server no longer knows has nowhere to reply; stop the work.
        // The same goes for a lease the server has not confirmed recently: the
        // watchdog trips one renew interval before the lease can expire,
        // measured from the server's own expiry (the claim response, then each
        // renewal's start time), because after expiry another runtime may
        // already be running the same invocation.
        let claimLost = false
        let leaseDeadline = new Date(invocation.claimExpiresAt).getTime() - LEASE_SAFETY_MS
        const loseClaim = (why: string) => {
          if (claimLost || turn !== turnGeneration) return
          claimLost = true
          clearInterval(renew)
          clearInterval(watchdog)
          deps.log(`claim ${invocation.id} ${why}; stopping the command`)
          runtime.interrupt()
        }
        const renew = setInterval(
          async () => {
            const startedAt = Date.now()
            const { notFound, renewed } = await transport.renewClaim(
              invocation.id,
              invocation.claimToken,
              CLAIM_TTL_SECONDS
            )
            if (turn !== turnGeneration) return
            if (notFound) loseClaim("lost (expired or reassigned)")
            else if (renewed) leaseDeadline = startedAt + CLAIM_TTL_SECONDS * 1000 - LEASE_SAFETY_MS
          },
          Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
        )
        const watchdog = setInterval(() => {
          if (Date.now() > leaseDeadline) loseClaim("lease unconfirmed too long")
        }, 5_000)
        await presence("busy")
        try {
          steps.begin(invocation.id, (frames) =>
            transport.recordSteps(
              invocation.id,
              invocation.claimToken,
              frames,
              `Running ${basename(args.command[0]!)}…`
            )
          )
          const outcome = await runtime.run(
            invocation.promptMarkdown,
            {
              THREA_INVOCATION_ID: invocation.id,
              THREA_STREAM_ID: invocation.responseStreamId,
              THREA_SOURCE_MESSAGE_ID: invocation.sourceMessageId,
            },
            (line) => {
              steps.push(invocation.id, line)
              deps.log(`${basename(args.command[0]!)}: ${line}`)
            }
          )
          await steps.finish(invocation.id)
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
          turnGeneration += 1
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
