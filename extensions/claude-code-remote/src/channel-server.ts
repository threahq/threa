import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { BotRuntimeTransport } from "@threa/bot-runtime-client"
import { z } from "zod"
import { downloadInboundAttachments, formatInboundAttachmentManifest, uploadReplyAttachments } from "./attachments"
import type { ThreaChannelConfig } from "./config"
import { ThreaClient, type ClaimedInvocation, type RuntimeSessionLink } from "./threa-client"
import { interrupt, STEER_SETTLE_MS, submitLine, tmuxAvailable } from "./tmux-control"

const RUNTIME_KIND = "claude-code-channel"
const SUPPORTED_CAPABILITIES = ["active-scratchpad", "mentionable"] as const
const SESSION_CONTROL_CAPABILITY = "session-control"
// The session-control slash commands this channel can actuate via tmux. Only
// advertised when running inside tmux. `run` types an arbitrary slash command
// (e.g. /remote-control); `compact` is sugar for `run /compact`.
const SESSION_CONTROL_COMMANDS = ["stop", "steer", "model", "compact", "run"] as const
// Claude Code `/model` aliases offered as autocomplete in the composer's arg picker.
const MODEL_SUGGESTIONS = [{ value: "default" }, { value: "sonnet" }, { value: "opus" }, { value: "opusplan" }]
// Mirror Pi's STEER_DRAIN_LIMIT: how many queued messages a single /steer folds
// into one combined turn before stopping (a backstop, not an expected count).
const STEER_DRAIN_LIMIT = 10

type SessionControlCommand = { name: string; args: string }
export const CHANNEL_SOURCE = "threa"
const CLAIM_TTL_SECONDS = 120
// Renew at a third of the lease so a single transient renew failure can't let
// the claim expire (two misses still leaves a full interval of margin).
const RENEW_INTERVAL_MS = Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
const WS_BACKSTOP_POLL_MS = 30_000
const MAX_CLAIMS_PER_DRAIN = 20
const MAX_CONTEXT_MESSAGES = 12
const MAX_MESSAGE_CHARS = 2_000
// Recent messages to scan for inbound attachments. The trigger message is always
// the newest, so this comfortably covers it plus the history Claude is shown.
const ATTACHMENT_SCAN_LIMIT = 30

/** "y abcde" / "yes abcde" / "n abcde" / "no abcde". The id alphabet skips 'l' (Claude Code's convention). */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

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
 * Turn a claimed invocation into the body Claude reads. The source message is
 * the request; any hydrated history follows as compact context. The body is
 * delivered inside `<channel source="threa" invocation_id="…">…</channel>`.
 */
export function formatInvocationContent(invocation: ClaimedInvocation): string {
  const prompt = invocation.promptMarkdown.trim() || "(empty message)"
  const history = (invocation.context?.messages ?? [])
    .filter((message) => message.messageId !== invocation.sourceMessageId)
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => {
      const author = message.authorDisplayName?.trim() || message.role
      const content = message.contentMarkdown.trim().slice(0, MAX_MESSAGE_CHARS)
      return `- ${author}: ${content}`
    })

  if (history.length === 0) return prompt
  return [prompt, "", "Earlier in this scratchpad (oldest first, for context):", ...history].join("\n")
}

export function buildInstructions(permissionRelay: boolean): string {
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
 * Extract the session-control command (name + args) from a claimed invocation.
 * Prefers the structured `metadata.command` the dispatch endpoint stamps; falls
 * back to parsing the `/name args` prompt for a session-control invocation.
 */
export function parseSessionControlCommand(invocation: ClaimedInvocation): SessionControlCommand | null {
  const meta = invocation.metadata?.command
  if (meta && typeof meta === "object") {
    const value = meta as Record<string, unknown>
    if (value.executionKind === "bot-runtime" && typeof value.name === "string") {
      return { name: value.name.toLowerCase(), args: typeof value.args === "string" ? value.args.trim() : "" }
    }
  }
  if (invocation.trigger !== SESSION_CONTROL_CAPABILITY) return null
  const match = invocation.promptMarkdown.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() }
}

export function isSessionControlInvocation(invocation: ClaimedInvocation): boolean {
  return invocation.trigger === SESSION_CONTROL_CAPABILITY && parseSessionControlCommand(invocation) !== null
}

/** Fold the steer text + any swept queued messages into one prompt (most recent last). */
export function buildSteerContent(parts: string[]): string {
  if (parts.length === 1) return parts[0]!
  return ["Handle all of the following together (most recent last):", "", parts.join("\n\n---\n\n")].join("\n")
}

/** Capabilities advertised in hello + presence. Session control only when we can drive the TUI. */
export function supportedCapabilitiesFor(sessionControlEnabled: boolean): string[] {
  return sessionControlEnabled ? [...SUPPORTED_CAPABILITIES, SESSION_CONTROL_CAPABILITY] : [...SUPPORTED_CAPABILITIES]
}

/**
 * Capabilities to claim with. Idle: everything we support. Busy (a turn in
 * flight): session-control ONLY, so /stop and /steer jump the queue while a
 * normal active-scratchpad follow-up waits. Empty when busy without TUI control
 * (callers must not claim in that state).
 */
export function claimCapabilitiesFor(busy: boolean, sessionControlEnabled: boolean): string[] {
  if (!busy) return supportedCapabilitiesFor(sessionControlEnabled)
  return sessionControlEnabled ? [SESSION_CONTROL_CAPABILITY] : []
}

export function runtimeCapabilitiesFor(
  runtimeSessionId: string,
  sessionControlEnabled: boolean
): Record<string, unknown> {
  return {
    runtimeSessionId,
    supportsActiveScratchpad: true,
    supportsPersistentSessions: true,
    ...(sessionControlEnabled
      ? {
          supportsSessionControlCommands: true,
          sessionControlCommands: [...SESSION_CONTROL_COMMANDS],
          modelSuggestions: MODEL_SUGGESTIONS,
        }
      : {}),
  }
}

interface Inflight {
  invocation: ClaimedInvocation
  // Idle-timeout timer; reset on every sign of life (a `send`, a permission
  // request) so an actively-working turn is never reaped, only a silent one.
  deadline: ReturnType<typeof setTimeout>
  // Count of interim `send` messages posted during this turn. When the idle
  // timeout fires after at least one send, the turn closes silently instead of
  // posting the "ended without a reply" notice — the user already heard from it.
  sentCount: number
  // The reply after THREA_ATTACH uploads, cached when a complete() fails so the
  // retry reuses the same uploads instead of orphaning a fresh copy each time.
  prepared?: { markdown: string; attachmentIds: string[] }
}

function log(message: string): void {
  // stdout is the MCP transport — everything diagnostic goes to stderr.
  process.stderr.write(`[threa-channel] ${message}\n`)
}

export class ChannelServer {
  private readonly mcp: Server
  private readonly transport: BotRuntimeTransport
  private link: RuntimeSessionLink | undefined
  private claiming = false
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private renewTimer: ReturnType<typeof setInterval> | undefined
  private readonly inflight = new Map<string, Inflight>()
  private readonly openPermissions = new Map<string, { cleanup: ReturnType<typeof setTimeout> }>()
  // Whether this channel can drive the Claude Code TUI (running inside tmux with a
  // known pane). Fixed at startup. Gates advertising + claiming session control.
  private readonly sessionControlEnabled = tmuxAvailable()
  // The invocation whose turn is executing — the stream a relayed permission
  // prompt belongs in. Set when a non-verdict invocation is pushed to Claude;
  // it's the turn that can trigger a tool-approval prompt. Tracking it beats
  // guessing from the in-flight map, where a follow-up message claimed during
  // an open-permission window would otherwise be picked as the (wrong) target.
  private activeTurnStreamId: string | undefined

  constructor(
    private readonly config: ThreaChannelConfig,
    private readonly client: ThreaClient,
    transport?: BotRuntimeTransport
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
      { capabilities, instructions: buildInstructions(config.permissionRelay) }
    )
    // The transport owns the /bot socket and routes presence/renew/steps over it
    // (HTTP fallback when the socket is down). Injectable for tests.
    this.transport =
      transport ??
      new BotRuntimeTransport({
        baseUrl: config.baseUrl,
        workspaceId: config.workspaceId,
        apiKey: config.apiKey,
        hello: {
          instanceId: config.instanceId,
          runtimeKind: RUNTIME_KIND,
          runtimeSessionId: config.runtimeSessionId,
          displayName: config.displayName,
          supportedCapabilities: supportedCapabilitiesFor(this.sessionControlEnabled),
          capabilities: runtimeCapabilitiesFor(config.runtimeSessionId, this.sessionControlEnabled),
          manifest: { output: { reply: true, trace: true, sources: false } },
        },
        callbacks: {
          onInvocationAvailable: () => void this.claimDrain(),
          onBootstrap: (bootstrap) => {
            if (bootstrap.availableInvocations.length > 0 || bootstrap.ownedClaims.length > 0) void this.claimDrain()
          },
        },
        log,
      })
    this.registerHandlers()
  }

  /** Connect the stdio transport so Claude Code can talk to the server and discover tools. */
  async connectStdio(): Promise<void> {
    await this.mcp.connect(new StdioServerTransport())
  }

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
      return req.params.name === "send" ? this.handleSend(invocationId, text) : this.handleReply(invocationId, text)
    })

    if (this.config.permissionRelay) {
      this.mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
        await this.handlePermissionRequest(params)
      })
    }
  }

  // --- Lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    await this.verifyPrincipal()
    await this.ensureLink()
    await this.transport.connect()
    this.startRenewTimer()
    this.startPoll()
    await this.claimDrain()
  }

  /** Create (or recover) the scratchpad link. Best-effort so a transient Threa outage self-heals on the next poll tick. */
  private async ensureLink(): Promise<void> {
    if (this.link || this.stopped) return
    try {
      this.link = await this.createSession()
      log(`linked to scratchpad ${this.config.baseUrl}${this.link.streamUrlPath}`)
      await this.syncPresence()
    } catch (error) {
      log(`could not link to Threa (will retry): ${this.summarize(error)}`)
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
    for (const [, open] of this.openPermissions) clearTimeout(open.cleanup)
    this.openPermissions.clear()
    // Fast, idempotent teardown first so SIGTERM cleanup isn't held hostage by
    // slow writes when Threa is the thing that's unreachable. Dropping the socket
    // before the offline push means updatePresence falls straight to HTTP rather
    // than waiting on an ack from a connection that's already going away.
    this.transport.disconnect()
    const inflight = [...this.inflight]
    for (const [, entry] of inflight) clearTimeout(entry.deadline)
    this.inflight.clear()
    await this.transport.updatePresence(this.presenceBody("offline")).catch(() => undefined)
    await Promise.allSettled(
      inflight.map(([id, entry]) =>
        this.client.fail(id, {
          instanceId: this.config.instanceId,
          claimToken: entry.invocation.claimToken,
          errorMessage: "Claude Code channel shut down",
        })
      )
    )
  }

  private async verifyPrincipal(): Promise<void> {
    try {
      const me = await this.client.getMe()
      if (me.kind !== "bot") {
        log("WARNING: the configured API key is not a bot key (threa_bk_…). Bot-runtime endpoints will reject it.")
      }
    } catch (error) {
      log(`could not verify principal (continuing): ${this.summarize(error)}`)
    }
  }

  private async createSession(): Promise<RuntimeSessionLink> {
    return this.client.createSession({
      runtimeKind: RUNTIME_KIND,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      displayName: this.config.displayName,
      localCwd: process.cwd(),
      ...(this.config.defaultLabel && { labelName: this.config.defaultLabel }),
    })
  }

  // --- Claiming -------------------------------------------------------------

  private async claimDrain(): Promise<void> {
    if (this.stopped || this.claiming) return
    this.claiming = true
    try {
      for (let i = 0; i < MAX_CLAIMS_PER_DRAIN; i++) {
        // One normal turn at a time: once a turn is in flight we claim with
        // session-control caps ONLY (claimBody(busy)), so /stop and /steer still
        // reach us mid-turn while a normal active-scratchpad follow-up stays
        // queued. A permission request is the exception — its verdict arrives as
        // an ordinary message and the in-flight turn is blocked until we route it,
        // so we keep draining with full caps. Without tmux control there's nothing
        // to claim while busy, so preserve strict one-at-a-time.
        const busy = this.inflight.size > 0 && this.openPermissions.size === 0
        if (busy && !this.sessionControlEnabled) break
        const invocation = await this.client.claim(this.claimBody(busy))
        if (!invocation) break
        if (isSessionControlInvocation(invocation)) {
          const isStop = parseSessionControlCommand(invocation)?.name === "stop"
          await this.handleSessionControl(invocation)
          // After a stop, don't immediately pull the next queued turn — the user
          // asked for quiet (mirrors Pi's runStopCommand).
          if (isStop) break
          continue
        }
        await this.handleClaimed(invocation)
      }
    } catch (error) {
      log(`claim failed: ${this.summarize(error)}`)
    } finally {
      this.claiming = false
    }
  }

  private async handleClaimed(invocation: ClaimedInvocation): Promise<void> {
    // A relayed permission verdict ("yes abcde") arrives as an ordinary message,
    // hence as a claimed invocation. Recognize it and route it to Claude Code as
    // a verdict instead of pushing it into the session as a fresh prompt.
    if (this.config.permissionRelay) {
      const verdict = parsePermissionVerdict(invocation.promptMarkdown)
      if (verdict) {
        const open = this.openPermissions.get(verdict.requestId)
        if (open) {
          clearTimeout(open.cleanup)
          this.openPermissions.delete(verdict.requestId)
          await this.notify("notifications/claude/channel/permission", {
            request_id: verdict.requestId,
            behavior: verdict.behavior,
          })
          await this.client
            .complete(invocation.id, {
              instanceId: this.config.instanceId,
              claimToken: invocation.claimToken,
              noResponse: true,
            })
            .catch((error) => log(`verdict ack failed: ${this.summarize(error)}`))
          return
        }
      }
    }

    const content = await this.buildChannelContent(invocation)
    await this.deliverTurn(invocation, content)
  }

  /** Register an invocation as the in-flight turn and push its content to Claude Code. */
  private async deliverTurn(invocation: ClaimedInvocation, content: string): Promise<void> {
    this.inflight.set(invocation.id, {
      invocation,
      deadline: this.scheduleIdleTimeout(invocation.id),
      sentCount: 0,
    })
    // This is the turn Claude is now executing; a permission prompt it triggers
    // belongs in this invocation's stream (see handlePermissionRequest).
    this.activeTurnStreamId = invocation.responseStreamId
    await this.syncPresence()
    await this.transport
      .recordSteps(
        invocation.id,
        invocation.claimToken,
        [{ stepType: "thinking", content: "Forwarded to Claude Code." }],
        "Working in Claude Code…"
      )
      .catch(() => undefined)
    await this.notify("notifications/claude/channel", {
      content,
      meta: {
        invocation_id: invocation.id,
        stream_id: invocation.responseStreamId,
        source_message_id: invocation.sourceMessageId,
      },
    })
  }

  // --- Session control (steer / stop / model / run) -------------------------

  private async handleSessionControl(invocation: ClaimedInvocation): Promise<void> {
    const command = parseSessionControlCommand(invocation)
    if (!command) {
      await this.failInvocation(invocation, "Missing session-control command metadata")
      return
    }
    try {
      switch (command.name) {
        case "stop":
          return await this.runStop(invocation)
        case "steer":
          return await this.runSteer(invocation, command.args)
        case "model":
          return await this.runModelCommand(invocation, command.args)
        case "compact":
          return await this.runSlashCommand(invocation, command.args ? `/compact ${command.args}` : "/compact")
        case "run":
          return await this.runRunCommand(invocation, command.args)
        default:
          await this.failInvocation(invocation, `Unsupported session-control command: ${command.name}`)
      }
    } catch (error) {
      await this.failInvocation(invocation, this.summarize(error))
    }
  }

  private async runStop(invocation: ClaimedInvocation): Promise<void> {
    const hadTurn = this.inflight.size > 0
    const sent = interrupt()
    await this.completeInterruptedTurns("Stopped by /stop.")
    const ack = !sent
      ? "Could not send the interrupt (no tmux control)."
      : hadTurn
        ? "Stopped the current Claude Code turn."
        : "Sent an interrupt to Claude Code."
    await this.completeAck(invocation, ack)
    await this.syncPresence()
  }

  /**
   * Interrupt the running turn, then fold the steer text + any messages queued
   * while Claude was busy into ONE combined turn (mirrors Pi: N messages → 1
   * response). tmux is used only for the interrupt; the combined content
   * round-trips through the normal notification path so Claude replies to it.
   */
  private async runSteer(invocation: ClaimedInvocation, text: string): Promise<void> {
    interrupt()
    await Bun.sleep(STEER_SETTLE_MS)
    await this.completeInterruptedTurns("Superseded by /steer.")

    const parts: string[] = []
    const swept: ClaimedInvocation[] = []
    for (let i = 0; i < STEER_DRAIN_LIMIT; i++) {
      const extra = await this.client.claim(this.claimBody(false)).catch(() => null)
      if (!extra) break
      swept.push(extra)
      if (isSessionControlInvocation(extra)) {
        // Fold a queued /steer's text in; other control commands in the sweep are
        // closed without execution (rare double-command race).
        const queued = parseSessionControlCommand(extra)
        if (queued?.name === "steer" && queued.args) parts.push(queued.args)
      } else {
        parts.push(extra.promptMarkdown.trim() || "(empty message)")
      }
    }
    if (text) parts.push(text)

    // Close every swept message with no response — its content is folded into the
    // single combined turn the primary (this steer invocation) will answer.
    await Promise.all(swept.map((item) => this.completeNoResponse(item)))

    if (parts.length === 0) {
      await this.completeAck(invocation, "Interrupted Claude Code; nothing pending to steer with.")
      await this.syncPresence()
      return
    }

    await this.deliverTurn(invocation, buildSteerContent(parts))
  }

  private async runModelCommand(invocation: ClaimedInvocation, args: string): Promise<void> {
    const alias = args.trim()
    if (!alias) {
      await this.completeAck(invocation, "Usage: `/model <name>` (e.g. sonnet, opus, default).")
      return
    }
    const ok = await submitLine(`/model ${alias}`)
    await this.completeAck(
      invocation,
      ok ? `Set Claude Code model to \`${alias}\`.` : "Could not send /model (no tmux control)."
    )
  }

  private async runRunCommand(invocation: ClaimedInvocation, args: string): Promise<void> {
    const raw = args.trim()
    if (!raw) {
      await this.completeAck(invocation, "Usage: `/run <slash-command>` (e.g. /run /remote-control).")
      return
    }
    await this.runSlashCommand(invocation, raw.startsWith("/") ? raw : `/${raw}`)
  }

  private async runSlashCommand(invocation: ClaimedInvocation, slash: string): Promise<void> {
    const ok = await submitLine(slash)
    await this.completeAck(
      invocation,
      ok ? `Ran \`${slash}\` in Claude Code.` : `Could not send \`${slash}\` (no tmux control).`
    )
  }

  private async completeAck(invocation: ClaimedInvocation, markdown: string): Promise<void> {
    await this.client
      .complete(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        finalMessageMarkdown: markdown,
        metadata: { "cc.channel.invocationId": invocation.id, "cc.channel.sessionControl": "true" },
      })
      .catch((error) => log(`session-control ack failed: ${this.summarize(error)}`))
  }

  private async completeNoResponse(invocation: ClaimedInvocation): Promise<void> {
    await this.client
      .complete(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        noResponse: true,
        metadata: { "cc.channel.invocationId": invocation.id, "cc.channel.steered": "true" },
      })
      .catch((error) => log(`steered close failed: ${this.summarize(error)}`))
  }

  private async failInvocation(invocation: ClaimedInvocation, errorMessage: string): Promise<void> {
    await this.client
      .fail(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        errorMessage: errorMessage.slice(0, 1000),
      })
      .catch((error) => log(`session-control fail failed: ${this.summarize(error)}`))
  }

  /** Close every in-flight turn that an interrupt just aborted, so none idle-hangs for an hour. */
  private async completeInterruptedTurns(note: string): Promise<void> {
    // Clear every entry's timer and drop it from the map BEFORE the first await.
    // If we cleared-and-completed one at a time, a sibling's idle-timeout could
    // fire at a `complete()` yield point, find itself still in the map, and
    // complete itself — then this loop double-completes it.
    const entries = [...this.inflight]
    for (const [id, entry] of entries) {
      this.clearInflight(id)
      if (this.activeTurnStreamId === entry.invocation.responseStreamId) this.activeTurnStreamId = undefined
    }
    await Promise.all(
      entries.map(([id, entry]) => {
        const body = entry.sentCount > 0 ? { noResponse: true } : { finalMessageMarkdown: `_${note}_` }
        return this.client
          .complete(id, {
            instanceId: this.config.instanceId,
            claimToken: entry.invocation.claimToken,
            ...body,
            metadata: { "cc.channel.invocationId": id, "cc.channel.interrupted": "true" },
          })
          .catch((error) => log(`interrupted-turn close failed: ${this.summarize(error)}`))
      })
    )
  }

  /** The prompt + history Claude reads, with any downloaded attachments appended as a manifest. */
  private async buildChannelContent(invocation: ClaimedInvocation): Promise<string> {
    const base = formatInvocationContent(invocation)
    // Best-effort: a discovery/download failure (e.g. a key without
    // attachments:read) must never block the prompt from reaching Claude.
    try {
      const downloaded = await downloadInboundAttachments(this.client, {
        streamId: invocation.activeStreamId,
        sourceMessageId: invocation.sourceMessageId,
        contextMessageIds: (invocation.context?.messages ?? []).map((message) => message.messageId),
        invocationId: invocation.id,
        cwd: process.cwd(),
        scanLimit: ATTACHMENT_SCAN_LIMIT,
        log,
      })
      const manifest = formatInboundAttachmentManifest(downloaded)
      return manifest ? `${base}\n\n${manifest}` : base
    } catch (error) {
      log(`inbound attachment scan failed: ${this.summarize(error)}`)
      return base
    }
  }

  // --- Send (interim) -------------------------------------------------------

  /** Post a progress message into the turn's stream without closing the request. */
  private async handleSend(
    invocationId: string,
    text: string
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    const entry = this.inflight.get(invocationId)
    if (!entry) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No open request with invocation_id ${invocationId} — interim messages need an open request (it may have been answered or closed).`,
          },
        ],
      }
    }
    // Stable per-send client id so a retry after a network failure dedupes
    // instead of double-posting; commit the counter only once the post lands.
    const seq = entry.sentCount + 1
    try {
      const { markdown } = await uploadReplyAttachments(this.client, text, process.cwd())
      await this.client.sendMessage(entry.invocation.responseStreamId, {
        content: markdown,
        clientMessageId: `ccsend-${invocationId}-${seq}`,
        metadata: { "cc.channel.invocationId": invocationId, "cc.channel.interim": "true" },
      })
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to post message to Threa: ${this.summarize(error)}` }],
      }
    }
    // The idle timer can fire during the awaits above — unlike handleReply, which
    // clears its deadline up front, this path must keep the turn open and can't.
    // If it fired, onReplyTimeout already removed this entry and completed the
    // turn, so the message we just posted landed on a closed turn. Report that
    // instead of a clean "sent" (and don't touch the dead entry), so Claude
    // doesn't then try to reply to a request that's gone.
    const live = this.inflight.get(invocationId)
    if (!live) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Message posted, but request ${invocationId} had already closed for inactivity — it is complete; do not reply to it.`,
          },
        ],
      }
    }
    live.sentCount = seq
    // A send is a sign of life: push the idle timeout out so a turn that keeps
    // posting progress is never force-closed.
    this.touchIdleTimeout(invocationId)
    return { content: [{ type: "text", text: "sent" }] }
  }

  // --- Reply ----------------------------------------------------------------

  private async handleReply(
    invocationId: string,
    text: string
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    const entry = this.inflight.get(invocationId)
    if (!entry) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `No open request with invocation_id ${invocationId} (already answered, expired, or unknown).`,
          },
        ],
      }
    }
    // Clear the entry (and its deadline) before awaiting complete(), so the
    // reply-timeout can't fire mid-await and double-complete the invocation.
    this.clearInflight(invocationId)
    // Reuse a prior attempt's uploads (cached on a complete() failure) so a
    // retry doesn't re-upload every THREA_ATTACH file and orphan the first copy.
    let prepared = entry.prepared
    try {
      if (!prepared) {
        // Upload any THREA_ATTACH files first; the reply markdown carries
        // attachment: links the backend associates with the posted message.
        const { markdown, uploaded } = await uploadReplyAttachments(this.client, text, process.cwd())
        prepared = { markdown, attachmentIds: uploaded.map((a) => a.id) }
      }
      await this.client.complete(invocationId, {
        instanceId: this.config.instanceId,
        claimToken: entry.invocation.claimToken,
        finalMessageMarkdown: prepared.markdown,
        metadata: {
          "cc.channel.invocationId": invocationId,
          "cc.channel.instanceId": this.config.instanceId,
          ...(prepared.attachmentIds.length > 0 && { "cc.channel.attachmentIds": prepared.attachmentIds.join(",") }),
        },
      })
    } catch (error) {
      // Re-arm (with a fresh deadline) so Claude can retry the reply. Safe from
      // double-complete because the original deadline was already cleared.
      this.inflight.set(invocationId, {
        invocation: entry.invocation,
        deadline: this.scheduleIdleTimeout(invocationId),
        sentCount: entry.sentCount,
        prepared,
      })
      await this.syncPresence()
      return {
        isError: true,
        content: [
          { type: "text", text: `Failed to post reply to Threa (will stay open for retry): ${this.summarize(error)}` },
        ],
      }
    }
    if (this.activeTurnStreamId === entry.invocation.responseStreamId) this.activeTurnStreamId = undefined
    await this.syncPresence()
    return { content: [{ type: "text", text: "sent" }] }
  }

  /** Fired when a turn goes idle (no `reply`/`send`/permission activity) for the whole idle window. */
  private async onReplyTimeout(invocationId: string): Promise<void> {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    this.clearInflight(invocationId)
    // If the turn already posted interim messages, the user has heard from it —
    // close silently rather than posting a misleading "no reply" notice.
    const closeBody =
      entry.sentCount > 0
        ? { noResponse: true }
        : { finalMessageMarkdown: "_Claude Code ended the turn without sending a reply._" }
    await this.client
      .complete(invocationId, {
        instanceId: this.config.instanceId,
        claimToken: entry.invocation.claimToken,
        ...closeBody,
        metadata: { "cc.channel.invocationId": invocationId, "cc.channel.timedOut": "true" },
      })
      .catch((error) => log(`timeout completion failed: ${this.summarize(error)}`))
    if (this.activeTurnStreamId === entry.invocation.responseStreamId) this.activeTurnStreamId = undefined
    await this.syncPresence()
  }

  private clearInflight(invocationId: string): void {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    clearTimeout(entry.deadline)
    this.inflight.delete(invocationId)
  }

  private scheduleIdleTimeout(invocationId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => void this.onReplyTimeout(invocationId), this.config.idleTimeoutMs)
  }

  /** Reset an in-flight turn's idle timeout after a sign of life (a `send`, a permission prompt). */
  private touchIdleTimeout(invocationId: string): void {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    clearTimeout(entry.deadline)
    entry.deadline = this.scheduleIdleTimeout(invocationId)
  }

  // --- Permission relay -----------------------------------------------------

  private async handlePermissionRequest(params: z.infer<typeof PermissionRequestSchema>["params"]): Promise<void> {
    // Post into the executing turn's stream (where the user is reading and will
    // reply), falling back to the scratchpad root.
    const targetStreamId = this.activeTurnStreamId ?? this.link?.rootStreamId
    if (!targetStreamId) return
    // A pending tool approval is a sign of life: keep the turn it belongs to from
    // being reaped for inactivity while it waits on the user's verdict.
    for (const [id, entry] of this.inflight) {
      if (entry.invocation.responseStreamId === targetStreamId) this.touchIdleTimeout(id)
    }
    // Drop the open request after the same idle window we give a turn, so an
    // abandoned/cancelled prompt the user never answers doesn't leak forever.
    const existing = this.openPermissions.get(params.request_id)
    if (existing) clearTimeout(existing.cleanup)
    const cleanup = setTimeout(() => this.openPermissions.delete(params.request_id), this.config.idleTimeoutMs)
    this.openPermissions.set(params.request_id, { cleanup })
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
    await this.client
      .sendMessage(targetStreamId, {
        content,
        clientMessageId: `ccperm-${params.request_id}`,
        metadata: { "cc.channel.permissionRequest": params.request_id },
      })
      .catch((error) => log(`permission relay send failed: ${this.summarize(error)}`))
  }

  // --- Timers ---------------------------------------------------------------

  private startRenewTimer(): void {
    this.renewTimer = setInterval(() => {
      for (const [id, entry] of [...this.inflight]) {
        // The .catch is fire-and-forget hygiene: a discarded promise in a
        // setInterval must never surface as an unhandled rejection (it's the
        // safety boundary if the .then body throws).
        void this.transport
          .renewClaim(id, entry.invocation.claimToken, CLAIM_TTL_SECONDS)
          .then((result) => {
            if (result.notFound) {
              // The claim's gone server-side; drop it and resync presence so a
              // last-in-flight loss doesn't strand the runtime as busy. Clear the
              // active-turn pointer too if this was it, so a relayed permission
              // prompt can't target a stream whose turn is no longer live.
              if (this.activeTurnStreamId === entry.invocation.responseStreamId) {
                this.activeTurnStreamId = undefined
              }
              this.clearInflight(id)
              void this.syncPresence()
            }
          })
          .catch((error) => log(`renew ${id} failed: ${this.summarize(error)}`))
      }
    }, RENEW_INTERVAL_MS)
  }

  private startPoll(): void {
    const tick = async () => {
      if (this.stopped) return
      if (!this.link) await this.ensureLink()
      if (!this.transport.socketConnected) await this.transport.connect()
      await this.claimDrain()
      const delay = this.transport.socketConnected ? WS_BACKSTOP_POLL_MS : this.config.pollMs
      this.pollTimer = setTimeout(() => void tick(), delay)
    }
    this.pollTimer = setTimeout(() => void tick(), this.config.pollMs)
  }

  // --- Helpers --------------------------------------------------------------

  /** Push presence derived from the current in-flight count, so rapid transitions converge on the truth. */
  private async syncPresence(): Promise<void> {
    const busy = this.inflight.size > 0
    await this.transport
      .updatePresence(this.presenceBody(busy ? "busy" : "available", busy ? "Working in Claude Code…" : undefined))
      .catch(() => undefined)
  }

  private presenceBody(status: "available" | "busy" | "offline", statusText?: string): Record<string, unknown> {
    return {
      runtimeKind: RUNTIME_KIND,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      displayName: this.config.displayName,
      status,
      acceptingInvocations: status === "available",
      // Full capabilities on EVERY presence update: the server replaces stored
      // capabilities on a presence:update (it doesn't merge), so omitting the
      // session-control keys here would wipe what bot:hello advertised.
      capabilities: runtimeCapabilitiesFor(this.config.runtimeSessionId, this.sessionControlEnabled),
      ...(statusText ? { statusText } : {}),
    }
  }

  private claimBody(busy: boolean): Record<string, unknown> {
    return {
      runtimeKind: RUNTIME_KIND,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      supportedCapabilities: claimCapabilitiesFor(busy, this.sessionControlEnabled),
      claimTtlSeconds: CLAIM_TTL_SECONDS,
    }
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.mcp
      .notification({ method, params })
      .catch((error) => log(`notify ${method} failed: ${this.summarize(error)}`))
  }

  private summarize(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200)
  }
}
