import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  harnessReconnectAvailable,
  prepareHarnessReconnect,
  runHarnessKick,
  parseAllowedTmuxKey,
  sendAllowedTmuxKey,
  type BotRuntimeTransport,
} from "@threa/bot-runtime-client"
import {
  DelegationClient,
  DelegationRunner,
  RemoteSession,
  ThreaClient,
  parseSessionControlCommand,
  type ClaimedDelegation,
  type ClaimedInvocation,
  type DelegationExecutorContext,
  type DeliveredTurn,
  type RemoteSessionConfig,
  type RemoteSessionStatusSnapshot,
  type SendResult,
  type SessionControlActuator,
} from "@threa/remote-session"
import { z } from "zod"
import { CarryOnController } from "./carry-on"
import { THINKING_LEVELS, modelSuggestions } from "./model-catalog"
import { pushBranchAndScheduleRemoval } from "./archive-cleanup"
import { formatClaudeStatusReport } from "./status"
import { interrupt, killOwnWindow, steerText, submitLine, tmuxAvailable } from "./tmux-control"
import { TranscriptTracer } from "./transcript-trace"

const RUNTIME_KIND = "claude-code-channel"
export const CHANNEL_SOURCE = "threa-channel"

// The session-control slash commands this channel can actuate via tmux. Only
// advertised when running inside tmux. `run` types an arbitrary slash command
// (e.g. /remote-control); `compact` is sugar for `run /compact`; `reload` maps
// to Claude Code's `/reload-skills` (pick up skills + custom commands added on
// disk this session — `/reload-plugins` is reachable via `run` for the plugin
// case); Threa's canonical `thinking` maps to Claude Code's `/effort`;
// `carry-on` queues text for the quota carry-on resume (see carry-on.ts);
// `kick` asks harnessd to press Enter in this session's pane; `status` reads
// connection/activity state and captures the visible pane without sending keys.
const SESSION_CONTROL_COMMANDS = [
  "stop",
  "steer",
  "kick",
  "status",
  "model",
  "thinking",
  "compact",
  "run",
  "reload",
  "carry-on",
  "reconnect",
  "key",
] as const
// Model options for the composer's arg picker: built-in /model aliases plus
// whatever the local client's own picker cache discovers (see model-catalog).
// Resolved once at startup — new models arrive with the next spawned session.
const MODEL_SUGGESTIONS = modelSuggestions()

/** "y abcde" / "yes abcde" / "n abcde" / "no abcde". The id alphabet skips 'l' (Claude Code's convention). */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const EMBEDDED_STEER_RE = /(^|[^\p{L}\p{N}_/])\/steer(?=$|[^\p{L}\p{N}_/-])/giu

// Delegation-queue backstop poll. The /bot socket pushes delegation:available,
// so like WS_BACKSTOP_POLL_MS in the SDK this is only insurance against a
// dropped push — every tick is a billed edge request.
const DELEGATION_BACKSTOP_POLL_MS = 15 * 60 * 1000

/**
 * The delegation brief as delivered into the Claude session. The event carries
 * its own send/reply protocol note because the server's static instructions
 * were written at connect time, before any delegation existed.
 */
export function formatDelegationContent(task: ClaimedDelegation): string {
  const refs = task.contextRefs.length > 0 ? ["", "Context references:", ...task.contextRefs.map((r) => `- ${r}`)] : []
  return [
    `<delegation source="${CHANNEL_SOURCE}" delegation_id="${task.id}" title=${JSON.stringify(task.title)}>`,
    task.brief.trim(),
    `</delegation>`,
    ...refs,
    "",
    "This is a Threa delegation this channel claimed — a self-contained task, separate from the scratchpad conversation. Do the work in this session against the real files.",
    `- Post progress with the \`send\` tool using invocation_id "${task.id}" — each send replaces the progress note on the delegation card.`,
    `- When finished, call \`reply\` exactly once with invocation_id "${task.id}" — the reply text is posted to the Threa stream as the delegation's result and completes it. If you are blocked, reply with a short account of what you tried and what blocked you.`,
  ].join("\n")
}

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

export interface PermissionVerdict {
  behavior: "allow" | "deny"
  requestId: string
}

export function parsePermissionVerdict(text: string): PermissionVerdict | null {
  const match = PERMISSION_REPLY_RE.exec(text)
  if (!match) return null
  return {
    behavior: match[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
    requestId: match[2]!.toLowerCase(),
  }
}

/**
 * The text of a claimed invocation that could carry a permission verdict: an
 * ordinary message's prompt, or a /steer's folded text — the busy-session
 * composer routes replies through /steer, so "yes abcde" often arrives as
 * steer args. Other session-control commands never carry a verdict.
 */
export function verdictCandidateText(invocation: ClaimedInvocation): string | null {
  const command = parseSessionControlCommand(invocation)
  if (command) return command.name === "steer" ? command.args : null

  // Embedded steer is now persisted as an ordinary source message plus an
  // empty structured steer invocation. When that source message is swept while
  // busy, retain the old permission-reply behavior by testing its text without
  // the embedded directive, regardless of where the user placed it.
  return invocation.promptMarkdown
    .replace(EMBEDDED_STEER_RE, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

export function buildInstructions(permissionRelay: boolean, channelActive = true): string {
  if (!channelActive) {
    return (
      `This Threa channel server is loaded as a plain MCP server — the current Claude session was not launched as a "${CHANNEL_SOURCE}" channel and is not linked to a Threa scratchpad. ` +
      "The send and reply tools are inactive; do not call them."
    )
  }
  const lines = [
    `You are linked to a Threa scratchpad through the "${CHANNEL_SOURCE}" channel.`,
    "",
    `Messages a user posts in that scratchpad arrive as <channel source="${CHANNEL_SOURCE}" invocation_id="…" stream_id="…">…the message…</channel>.`,
    "",
    "For each such event:",
    "- Do the work it asks for in this session, against the real files.",
    "- While you work, call the `send` tool to post progress or intermediate messages back to the scratchpad (passing the same `invocation_id`). It does NOT close the request, so you can call it as many times as you like — use it for partial answers, status on a long task, or anything worth surfacing before you're done. On a long task, send something periodically: it keeps the user informed and keeps the request from being closed for inactivity.",
    "- When you are finished, call the `reply` tool exactly once with the `invocation_id` and your final answer. `reply` posts the message AND closes the request on Threa, so call it last. If you have nothing to add after your `send` messages, still call `reply` (a short 'Done.' is fine) to close cleanly.",
    "- One `reply` per invocation_id. If several events arrive together, answer each by its own id.",
    "",
    "Attachments. If a message has attachments, the channel downloads them into the working directory and lists each local path under the event — read them from those paths. To send a local file back, add a line `THREA_ATTACH: path/to/file` to your reply text (one per file; paths resolve against the working directory); the channel uploads it and replaces the line with an attachment link.",
  ]
  if (permissionRelay) {
    lines.push(
      "",
      "When you use a tool that needs approval, Claude Code forwards the prompt to the Threa scratchpad for the user to approve there. Proceed normally; you don't need to do anything special."
    )
  }
  return lines.join("\n")
}

/**
 * Execute an advertised session-control command by typing its Claude Code
 * slash-command equivalent into the tmux pane. `stop`/`steer` never reach this
 * — the SDK actuates those itself via `interrupt`/`steer`.
 */
type ReconnectTarget = Pick<RemoteSessionStatusSnapshot, "stopped" | "linkGeneration" | "linkState" | "rootStreamId">

export async function runClaudeCommand(
  name: string,
  args: string,
  carryOn?: CarryOnController,
  runtimeSessionId?: string,
  statusReport?: () => string,
  rootStreamId?: () => string | undefined,
  reconnectBusy?: () => boolean,
  stopDelegationsForReconnect?: (force: boolean) => Promise<void>,
  restartDelegationsAfterReset?: () => void,
  reconnectTarget?: () => ReconnectTarget,
  reconnectReady?: () => boolean,
  keySender: typeof sendAllowedTmuxKey = sendAllowedTmuxKey
): Promise<{
  ok: boolean
  message: string
  afterAck?: () => void | Promise<void>
  onHandoffReset?: () => void
}> {
  switch (name) {
    case "key": {
      const key = parseAllowedTmuxKey(args)
      if (!key) return { ok: false, message: "Usage: `/key <name>`." }
      if (!runtimeSessionId || !rootStreamId?.()) throw new Error("Key control is unavailable for this session.")
      keySender(key, process.ppid)
      return { ok: true, message: `Sent \`${key}\` to the linked Claude session.` }
    }
    case "reconnect": {
      if (args !== "" && args !== "--force") {
        return { ok: false, message: "Usage: `/reconnect [--force]`." }
      }
      if (args !== "--force" && reconnectBusy?.()) {
        return { ok: false, message: "Claude is busy; retry when idle or use `/reconnect --force`." }
      }
      const target = reconnectTarget?.()
      const root = target?.rootStreamId ?? rootStreamId?.()
      if (!runtimeSessionId || !root) throw new Error("Harness reconnect is unavailable for this session.")
      const force = args === "--force"
      const startReconnect = prepareHarnessReconnect(runtimeSessionId, root, { force })
      return {
        ok: true,
        message: "Reconnect request accepted; attempting to resume the linked Claude session.",
        afterAck: async () => {
          if (!force && reconnectBusy?.()) {
            throw new Error(
              "Claude became busy after reconnect acknowledgement; retry when idle or use `/reconnect --force`."
            )
          }
          await stopDelegationsForReconnect?.(force)
          const current = reconnectTarget?.()
          if (
            reconnectReady?.() === false ||
            (current &&
              (current.stopped ||
                current.linkState !== "linked" ||
                current.rootStreamId !== root ||
                current.linkGeneration !== target?.linkGeneration))
          ) {
            throw new Error("Remote session changed while delegation intake was quiescing; reconnect was not started.")
          }
          startReconnect()
        },
        onHandoffReset: restartDelegationsAfterReset,
      }
    }
    case "carry-on": {
      if (!carryOn) return { ok: false, message: "Quota carry-on is unavailable for this session." }
      return carryOn.enqueue(args)
    }
    case "kick": {
      if (!runtimeSessionId) throw new Error("Harness kick is unavailable for this session.")
      const result = runHarnessKick(runtimeSessionId)
      if (!result.ok) throw new Error(`Could not kick the session: ${result.error}`)
      return { ok: true, message: "Kicked the linked Claude Code session." }
    }
    case "status": {
      if (!statusReport) return { ok: false, message: "Session status is unavailable." }
      try {
        return { ok: true, message: statusReport() }
      } catch (error) {
        return {
          ok: false,
          message: `Could not inspect the session: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    case "model": {
      const alias = args.trim()
      if (!alias) return { ok: false, message: "Usage: `/model <name>` (e.g. fable, opus, sonnet, haiku, default)." }
      // `/model <name>` sets directly in current Claude Code (v2.1.199 dropped
      // the old "Switch model?" confirm dialog), so one submit is the whole action.
      const ok = await submitLine(`/model ${alias}`)
      return { ok, message: ok ? `Set Claude Code model to \`${alias}\`.` : "Could not send /model (no tmux control)." }
    }
    case "thinking": {
      // Threa's canonical `/thinking <level>` actuated as Claude Code's `/effort`.
      // Levels are validated against the advertised set so a typo gets usage help
      // instead of an Enter submitted into the TUI's effort slider.
      const level = args.trim().toLowerCase()
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
        return { ok: false, message: `Usage: \`/thinking <level>\` — one of ${THINKING_LEVELS.join(", ")}.` }
      }
      const ok = await submitLine(`/effort ${level}`)
      return {
        ok,
        message: ok ? `Set Claude Code effort to \`${level}\`.` : "Could not send /effort (no tmux control).",
      }
    }
    case "compact":
      return runSlash(args.trim() ? `/compact ${args.trim()}` : "/compact")
    case "reload":
      // Claude Code has no single "reload everything"; /reload-skills picks up
      // skills + custom commands added on disk mid-session (newly `claude mcp
      // add`'d MCP servers still need a restart). /reload-plugins via `run`.
      return runSlash("/reload-skills")
    case "run": {
      const raw = args.trim()
      if (!raw) return { ok: false, message: "Usage: `/run <slash-command>` (e.g. /run /remote-control)." }
      return runSlash(raw.startsWith("/") ? raw : `/${raw}`)
    }
    default:
      return { ok: false, message: `Unsupported session-control command: ${name}` }
  }
}

async function runSlash(slash: string): Promise<{ ok: boolean; message: string }> {
  const ok = await submitLine(slash)
  return { ok, message: ok ? `Ran \`${slash}\` in Claude Code.` : `Could not send \`${slash}\` (no tmux control).` }
}

/**
 * The tmux actuator, present only when we can actually drive the TUI
 * (fail-safe: no control → no commands offered). `carryOn` is late-bound: the
 * controller needs the constructed session, which needs this actuator first.
 */
export function createClaudeSessionControl(
  carryOn: () => CarryOnController | undefined = () => undefined,
  runtimeSessionId?: string,
  statusReport?: () => string,
  rootStreamId?: () => string | undefined,
  reconnectBusy?: () => boolean,
  stopDelegationsForReconnect?: (force: boolean) => Promise<void>,
  restartDelegationsAfterReset?: () => void,
  reconnectTarget?: () => ReconnectTarget,
  reconnectReady?: () => boolean
): SessionControlActuator | undefined {
  if (!tmuxAvailable()) return undefined
  return {
    get commands() {
      return runtimeSessionId
        ? SESSION_CONTROL_COMMANDS.filter((command) => {
            if (command === "reconnect") return Boolean(rootStreamId?.() && harnessReconnectAvailable())
            if (command === "key") return Boolean(rootStreamId?.() && process.env.TMUX_PANE?.trim())
            return true
          })
        : SESSION_CONTROL_COMMANDS.filter(
            (command) => command !== "kick" && command !== "reconnect" && command !== "key"
          )
    },
    modelSuggestions: MODEL_SUGGESTIONS,
    thinkingLevels: [...THINKING_LEVELS],
    interrupt: () => {
      // A /stop is about to close the held turn — drop the hold (and surface
      // any queued carry-on texts) before the interrupt lands.
      carryOn()?.onInterrupt()
      return interrupt()
    },
    // The prefix tells the model mid-turn text came from the scratchpad, so it
    // folds it into the open invocation's work rather than treating it as a
    // side conversation at the terminal.
    steer: (text) => {
      // While blocked on quota the session is idle at a dead prompt — pasting
      // would submit a fresh turn that dies the same way. Queue it instead.
      const absorbed = carryOn()?.absorbSteer(text)
      if (absorbed !== undefined) return true
      return steerText(`[Steer from the Threa scratchpad — fold into the current work]\n${text}`)
    },
    runCommand: (name, args) =>
      runClaudeCommand(
        name,
        args,
        carryOn(),
        runtimeSessionId,
        statusReport,
        rootStreamId,
        reconnectBusy,
        stopDelegationsForReconnect,
        restartDelegationsAfterReset,
        reconnectTarget,
        reconnectReady
      ),
  }
}

function log(message: string): void {
  // stdout is the MCP transport — everything diagnostic goes to stderr.
  process.stderr.write(`[threa-channel] ${message}\n`)
}

/**
 * The Claude Code connector: an MCP server bridging a Claude Code session to a
 * Threa scratchpad. All session mechanics (linking, claiming, steer/stop,
 * presence, idle timeouts) live in `RemoteSession`; this class owns only what
 * is Claude-specific — the stdio MCP surface (`send`/`reply` tools + channel
 * notifications), the tmux actuator, and the permission-prompt relay.
 */
export class ChannelServer {
  private readonly mcp: Server
  readonly session: RemoteSession
  private readonly tracer: TranscriptTracer
  private readonly carryOn: CarryOnController | undefined
  private readonly openPermissions = new Map<string, { cleanup: ReturnType<typeof setTimeout> }>()
  private readonly delegations: DelegationRunner | undefined
  /** Delegation turns awaiting Claude's reply, keyed by delegation id (the tool-call invocation_id). */
  private readonly openDelegations = new Map<
    string,
    {
      resolve: (resultMarkdown: string) => void
      reject: (error: Error) => void
      ctx: DelegationExecutorContext
      keepAlive: () => void
      clear: () => void
    }
  >()
  private started = false
  private shuttingDown = false

  constructor(
    private readonly config: RemoteSessionConfig,
    client: ThreaClient,
    transport?: BotRuntimeTransport,
    channelActive = true,
    delegationClient?: DelegationClient
  ) {
    const capabilities: Record<string, unknown> = {
      experimental: { "claude/channel": {} },
      tools: {},
    }
    if (config.permissionRelay) {
      ;(capabilities.experimental as Record<string, unknown>)["claude/channel/permission"] = {}
    }
    this.mcp = new Server(
      { name: CHANNEL_SOURCE, version: "0.1.0" },
      { capabilities, instructions: buildInstructions(config.permissionRelay, channelActive) }
    )
    // The runner races other connectors for workspace-wide tasks, so only an
    // explicitly opted-in channel runs one; the queue is claim-CAS-safe either way.
    if (config.delegations && channelActive) {
      this.delegations = new DelegationRunner({
        client: delegationClient ?? new DelegationClient(config),
        executor: (task, ctx) => this.runDelegationThroughClaude(task, ctx),
        claimedByLabel: config.displayName,
        pollMs: DELEGATION_BACKSTOP_POLL_MS,
        log,
      })
    }
    this.session = new RemoteSession({
      config,
      client,
      transport,
      onDelegationAvailable: (payload) => this.delegations?.notifyAvailable(payload),
      log,
      runtime: {
        kind: RUNTIME_KIND,
        manifest: { output: { reply: true, trace: true, sources: false } },
        busyStatusText: "Working in Claude Code…",
        forwardedNote: "Forwarded to Claude Code.",
        shutdownErrorMessage: "Claude Code channel shut down",
      },
      delegate: {
        deliverTurn: (turn) => this.deliverToClaude(turn),
        sessionControl: createClaudeSessionControl(
          () => this.carryOn,
          config.runtimeSessionId,
          () =>
            formatClaudeStatusReport({
              channelStarted: this.started,
              instanceId: config.instanceId,
              runtimeSessionId: config.runtimeSessionId,
              remote: this.session.statusSnapshot,
              quotaHolding: this.carryOn?.holding ?? false,
              pendingPermissionCount: this.openPermissions.size,
              activeDelegationCount: this.openDelegations.size,
            }),
          () => this.session?.rootStreamId,
          () => this.reconnectBusy(),
          (force) => this.stopDelegationsForReconnect(force),
          () => this.restartDelegationsAfterReset(),
          () => {
            const remote = this.session.statusSnapshot
            return { ...remote, rootStreamId: this.session.rootStreamId }
          },
          () => !this.shuttingDown
        ),
        onArchived: () => this.windDownForArchive(),
        ...(config.permissionRelay
          ? { interceptClaimed: (invocation: ClaimedInvocation) => this.interceptVerdict(invocation) }
          : {}),
      },
    })
    // Quota carry-on needs the tmux pane to type the resume into — without it
    // a detected quota hit changes nothing (the turn idles out as before).
    this.carryOn = tmuxAvailable()
      ? new CarryOnController({
          isInflight: (invocationId) => this.session.isInflight(invocationId),
          keepAlive: (streamId) => this.session.keepAlive(streamId),
          postNotice: (streamId, text) => this.session.postToStream(streamId, { content: text }),
          closeTurn: async (invocationId, text) => {
            const result = await this.session.reply(invocationId, text)
            if (!result.ok) throw new Error(result.message)
          },
          inject: (text) => steerText(text),
          log,
        })
      : undefined
    // Steps ship only while the SDK holds the turn in flight — recordSteps
    // returns false once the invocation closes, which stops the tail.
    this.tracer = new TranscriptTracer({
      emit: (invocationId, frames, statusText) => this.session.recordSteps(invocationId, frames, statusText),
      onApiError: (invocationId, text) => this.carryOn?.onApiError(invocationId, text),
      log,
    })
    this.registerHandlers()
  }

  private reconnectBusy(): boolean {
    return (
      (this.session.statusSnapshot.inflightCount ?? 0) > 0 ||
      (this.carryOn?.holding ?? false) ||
      this.openDelegations.size > 0
    )
  }

  private async stopDelegationsForReconnect(force: boolean): Promise<void> {
    const reason = "Claude Code channel reconnected mid-delegation"
    const stopping = this.delegations?.stop(reason, { strict: true }) ?? Promise.resolve()

    if (force) {
      this.failOpenDelegations(reason)
      await stopping
      return
    }

    if (this.openDelegations.size > 0) {
      void stopping.catch((error) =>
        log(`delegation stop failed: ${error instanceof Error ? error.message : String(error)}`)
      )
      throw new Error(
        "Claude became busy after reconnect acknowledgement; retry when idle or use `/reconnect --force`."
      )
    }

    await stopping
    if (this.openDelegations.size > 0) {
      throw new Error(
        "Claude became busy after reconnect acknowledgement; retry when idle or use `/reconnect --force`."
      )
    }
  }

  private restartDelegationsAfterReset(): void {
    if (this.started && !this.shuttingDown) this.delegations?.start()
  }

  /** Connect the stdio transport so Claude Code can talk to the server and discover tools. */
  async connectStdio(): Promise<void> {
    await this.mcp.connect(new StdioServerTransport())
  }

  async start(): Promise<void> {
    this.started = true
    await this.session.start()
    this.delegations?.start()
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.tracer.stop()
    this.carryOn?.stop()
    // Fail an in-flight delegation loudly (its executor promise rejects →
    // the runner posts the failure) rather than stranding the claim until the
    // 15-minute lease sweep. stop() resolves after that fail report lands.
    this.failOpenDelegations("Claude Code channel shut down mid-delegation")
    await this.delegations?.stop()
    for (const [, open] of this.openPermissions) clearTimeout(open.cleanup)
    this.openPermissions.clear()
    // A never-started session has nothing linked — skipping its shutdown keeps
    // plain-MCP teardown from writing an offline-presence row for an instance
    // that never existed on the Threa side.
    if (this.started) await this.session.shutdown()
  }

  /**
   * The scratchpad was archived (SDK is already offline). Preserve the work on
   * the remote, then take the whole tmux window down — Claude Code, this
   * channel, and the shell die together; a detached helper removes the
   * worktree afterwards. Recovery is `git fetch` + the pushed branch, never a
   * local revival. Outside tmux there is nothing to kill but ourselves.
   */
  private windDownForArchive(): void {
    log("scratchpad archived — preserving work and shutting down")
    const report = pushBranchAndScheduleRemoval(process.cwd(), log)
    log(
      `archive cleanup: committed=${report.committed} pushed=${report.pushed} removal=${report.removalScheduled}` +
        (report.reason ? ` (${report.reason})` : "")
    )
    if (!killOwnWindow()) process.exit(0)
  }

  // --- Delegations ------------------------------------------------------------

  /**
   * The deliver-to-Claude actuator for the SDK's DelegationRunner: push the
   * brief into the live session as a channel event and resolve with whatever
   * Claude passes to `reply`. All delegation lifecycle (claim, heartbeat,
   * complete/fail) lives in the runner — this method only bridges brief → Claude
   * → result text.
   */
  private async runDelegationThroughClaude(
    task: ClaimedDelegation,
    ctx: DelegationExecutorContext
  ): Promise<{ resultMarkdown: string }> {
    try {
      const resultMarkdown = await new Promise<string>((resolve, reject) => {
        // Same wedged-turn safety net as scratchpad turns: reap only after
        // idleTimeoutMs of SILENCE — every send (progress note) re-arms it.
        let deadline: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
          clearTimeout(deadline)
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `Delegation went silent in Claude Code for ${Math.round(this.config.idleTimeoutMs / 60_000)} minutes without a reply`
                )
              ),
            this.config.idleTimeoutMs
          )
        }
        arm()
        this.openDelegations.set(task.id, {
          resolve,
          reject,
          ctx,
          keepAlive: arm,
          clear: () => clearTimeout(deadline),
        })
        void this.notify("notifications/claude/channel", {
          content: formatDelegationContent(task),
          meta: { invocation_id: task.id, stream_id: task.streamId },
        })
      })
      return { resultMarkdown }
    } finally {
      this.openDelegations.get(task.id)?.clear()
      this.openDelegations.delete(task.id)
    }
  }

  private failOpenDelegations(reason: string): void {
    // Entries remove themselves via each executor's finally.
    for (const [, open] of this.openDelegations) open.reject(new Error(reason))
  }

  // --- Turn delivery ----------------------------------------------------------

  private async deliverToClaude(turn: DeliveredTurn): Promise<void> {
    // Window the transcript tail BEFORE the content is pushed, so the tracer's
    // start offset precedes the prompt echo it binds on.
    // A sealed turn's steps are ciphertext to the server, so the tracer may
    // run full-detail (the owner opted back to redacted via sealedFullTrace=false).
    this.tracer.beginTurn(turn.invocationId, turn.sealed && this.config.sealedFullTrace ? "full" : undefined)
    this.carryOn?.onTurnStarted(turn.invocationId, turn.streamId)
    await this.notify("notifications/claude/channel", {
      content: turn.content,
      meta: {
        invocation_id: turn.invocationId,
        stream_id: turn.streamId,
        source_message_id: turn.sourceMessageId,
      },
    })
  }

  // --- MCP tool surface --------------------------------------------------------

  private registerHandlers(): void {
    this.mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "send",
          description:
            "Post a progress or intermediate message to the Threa scratchpad WITHOUT closing the request. Call as many times as you like during a turn; finish with `reply`.",
          inputSchema: {
            type: "object",
            properties: {
              invocation_id: {
                type: "string",
                description: "The invocation_id from the <channel> event you are working on.",
              },
              text: { type: "string", description: "The message to post, as markdown." },
            },
            required: ["invocation_id", "text"],
          },
        },
        {
          name: "reply",
          description:
            "Post your final answer to the Threa scratchpad and close the request. Call once per invocation_id, last.",
          inputSchema: {
            type: "object",
            properties: {
              invocation_id: {
                type: "string",
                description: "The invocation_id from the <channel> event you are answering.",
              },
              text: { type: "string", description: "Your reply, as markdown." },
            },
            required: ["invocation_id", "text"],
          },
        },
      ],
    }))

    this.mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name !== "reply" && req.params.name !== "send") {
        return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] }
      }
      const args = (req.params.arguments ?? {}) as { invocation_id?: unknown; text?: unknown }
      const invocationId = typeof args.invocation_id === "string" ? args.invocation_id : ""
      const text = typeof args.text === "string" ? args.text : ""
      if (!invocationId || !text.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: `${req.params.name} requires a non-empty invocation_id and text.` }],
        }
      }
      return toToolResult(await this.handleToolCall(req.params.name, invocationId, text))
    })

    if (this.config.permissionRelay) {
      this.mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
        await this.handlePermissionRequest(params)
      })
    }
  }

  /**
   * The send/reply dispatch behind the MCP tool handler (public for tests).
   * A delegation id routes to its waiting executor — send becomes the card's
   * progress note, reply resolves it — everything else is a scratchpad turn.
   */
  async handleToolCall(name: "send" | "reply", invocationId: string, text: string): Promise<SendResult> {
    const delegation = this.openDelegations.get(invocationId)
    if (delegation) {
      delegation.keepAlive()
      if (name === "send") {
        await delegation.ctx.reportStatus(text)
        return { ok: true, message: "Progress noted on the delegation card." }
      }
      delegation.resolve(text)
      return { ok: true, message: "Delegation result posted to the Threa stream; the request is closed." }
    }
    const result =
      name === "send"
        ? await this.session.sendInterim(invocationId, text)
        : await this.session.reply(invocationId, text)
    if (name === "reply" && result.ok) {
      this.tracer.endTurn(invocationId)
      this.carryOn?.onTurnClosed(invocationId)
    }
    return result
  }

  // --- Permission relay -----------------------------------------------------

  /**
   * A relayed permission verdict ("yes abcde") arrives as a claimed invocation
   * — an ordinary message, or /steer args when the session was busy. Recognize
   * it and route it to Claude Code as a verdict instead of pushing it into the
   * session as a fresh prompt or steering text.
   */
  private async interceptVerdict(invocation: ClaimedInvocation): Promise<boolean> {
    const text = verdictCandidateText(invocation)
    if (text === null) return false
    const verdict = parsePermissionVerdict(text)
    if (!verdict) return false
    const open = this.openPermissions.get(verdict.requestId)
    if (!open) return false
    clearTimeout(open.cleanup)
    this.openPermissions.delete(verdict.requestId)
    this.syncInterceptHold()
    await this.notify("notifications/claude/channel/permission", {
      request_id: verdict.requestId,
      behavior: verdict.behavior,
    })
    return true
  }

  private async handlePermissionRequest(params: z.infer<typeof PermissionRequestSchema>["params"]): Promise<void> {
    // Post into the executing turn's stream (where the user is reading and will
    // reply), falling back to the scratchpad root.
    const targetStreamId = this.session.activeTurnStreamId ?? this.session.rootStreamId
    if (!targetStreamId) return
    // A pending tool approval is a sign of life: keep the turn it belongs to from
    // being reaped for inactivity while it waits on the user's verdict.
    this.session.keepAlive(targetStreamId)
    // Drop the open request after the same idle window we give a turn, so an
    // abandoned/cancelled prompt the user never answers doesn't leak forever.
    const existing = this.openPermissions.get(params.request_id)
    if (existing) clearTimeout(existing.cleanup)
    const cleanup = setTimeout(() => {
      this.openPermissions.delete(params.request_id)
      this.syncInterceptHold()
    }, this.config.idleTimeoutMs)
    this.openPermissions.set(params.request_id, { cleanup })
    this.syncInterceptHold()
    const preview = params.input_preview ? `\n\n\`${params.input_preview.slice(0, 200)}\`` : ""
    const content = [
      `**Claude Code wants to run \`${params.tool_name}\`**`,
      params.description,
      preview,
      "",
      `Reply \`yes ${params.request_id}\` to allow or \`no ${params.request_id}\` to deny.`,
    ]
      .filter(Boolean)
      .join("\n")
    await this.session
      .postToStream(targetStreamId, {
        content,
        clientMessageId: `ccperm-${params.request_id}`,
        metadata: { "cc.channel.permissionRequest": params.request_id },
      })
      .catch((error) => log(`permission relay send failed: ${error instanceof Error ? error.message : String(error)}`))
  }

  /**
   * While a permission prompt is open, its verdict arrives as an ordinary
   * message and the in-flight turn is blocked until we route it — so the SDK
   * must keep claiming with full capabilities instead of session-control only.
   */
  private syncInterceptHold(): void {
    this.session.interceptHoldsClaims = this.openPermissions.size > 0
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.mcp
      .notification({ method, params })
      .catch((error) => log(`notify ${method} failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}

function toToolResult(result: SendResult): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return result.ok
    ? { content: [{ type: "text", text: result.message }] }
    : { isError: true, content: [{ type: "text", text: result.message }] }
}
