import { BotRuntimeTransport, type BotRuntimeHello } from "@threa/bot-runtime-client"
import { downloadInboundAttachments, formatInboundAttachmentManifest, uploadReplyAttachments } from "./attachments"
import type { RemoteSessionConfig } from "./identity"
import { ThreaClient, type ClaimedInvocation, type RuntimeSessionLink } from "./client"

export const SUPPORTED_CAPABILITIES = ["active-scratchpad", "mentionable"] as const
export const SESSION_CONTROL_CAPABILITY = "session-control"
// Mirror Pi's STEER_DRAIN_LIMIT: how many queued messages a single /steer folds
// into one combined turn before stopping (a backstop, not an expected count).
const STEER_DRAIN_LIMIT = 10
/** Milliseconds to wait after an interrupt before delivering the steer turn, so the runtime has returned to idle. */
export const STEER_SETTLE_MS = 250

const CLAIM_TTL_SECONDS = 120
// Renew at a third of the lease so a single transient renew failure can't let
// the claim expire (two misses still leaves a full interval of margin).
const RENEW_INTERVAL_MS = Math.floor((CLAIM_TTL_SECONDS * 1000) / 3)
// While the /bot socket is healthy the server PUSHES work (bot_invocation:available,
// plus the hello bootstrap on every connect/resync), so this poll is only
// insurance against a silently dropped push. Every tick is an HTTP claim through
// the billed edge Worker — at 30s an idle fleet of sessions burned thousands of
// requests/day doing nothing. 15 min bounds a lost push's worst-case latency at
// ~100 requests/day/session; reconnects still drain immediately via the hello
// bootstrap callback.
const WS_BACKSTOP_POLL_MS = 15 * 60 * 1000
const MAX_CLAIMS_PER_DRAIN = 20
const MAX_CONTEXT_MESSAGES = 12
const MAX_MESSAGE_CHARS = 2_000
// Recent messages to scan for inbound attachments. The trigger message is always
// the newest, so this comfortably covers it plus the history the agent is shown.
const ATTACHMENT_SCAN_LIMIT = 30

export interface ModelSuggestionInfo {
  value: string
  label?: string
  description?: string
}

/** A turn handed to the connector for execution by its runtime. */
export interface DeliveredTurn {
  invocationId: string
  streamId: string
  sourceMessageId: string
  content: string
}

/**
 * How a connector drives its runtime for session control. `stop` and `steer`
 * are actuated by the SDK itself (they manipulate SDK-owned turn state) using
 * `interrupt()`; every other advertised command is routed to `runCommand`,
 * which returns the user-facing ack markdown.
 */
export interface SessionControlActuator {
  /** Command names to advertise (must be Threa catalog names, e.g. "model", "thinking", "compact", "run", "reload", "steer", "stop"). */
  commands: readonly string[]
  /** Model options for the composer's arg picker. */
  modelSuggestions?: readonly ModelSuggestionInfo[]
  /** Levels for the canonical /thinking command's arg picker. */
  thinkingLevels?: readonly string[]
  /** Interrupt the runtime's current turn. False = control lost (e.g. pane gone). */
  interrupt(): boolean
  /** Execute an advertised non-steer/stop command. Returns the ack posted to the scratchpad. */
  runCommand(name: string, args: string): Promise<{ ok: boolean; message: string }>
}

/**
 * What a connector implements. The SDK owns the whole session lifecycle —
 * linking, claiming, steer/stop semantics, presence, idle timeouts, claim
 * renewal, attachments — and calls the delegate at the two points a runtime
 * differs: delivering a turn into it, and (optionally) driving it.
 */
export interface RemoteSessionDelegate {
  /** Push a turn into the runtime. Resolve when handed off (not when answered). */
  deliverTurn(turn: DeliveredTurn): Promise<void>
  /**
   * Inspect a claimed invocation before it becomes a turn (e.g. a relayed
   * tool-approval verdict). Return true when consumed; the SDK then closes it
   * silently and moves on.
   */
  interceptClaimed?(invocation: ClaimedInvocation): Promise<boolean>
  /** Present iff the connector can drive the runtime. Gates advertising session control (fail-safe). */
  sessionControl?: SessionControlActuator
}

/** The connector's runtime identity and user-facing wording. */
export interface RuntimeDescriptor {
  /** Threa runtime kind, e.g. "claude-code-channel". */
  kind: string
  /** `bot:hello` output manifest. */
  manifest?: BotRuntimeHello["manifest"]
  /** Presence status text while a turn is executing, e.g. "Working in Claude Code…". */
  busyStatusText: string
  /** Trace note recorded when a turn is handed to the runtime. */
  forwardedNote: string
  /** Error recorded on in-flight turns when the session shuts down. */
  shutdownErrorMessage: string
}

export interface SendResult {
  ok: boolean
  message: string
  /** Set when the failure leaves the request open so the caller may retry. */
  retryable?: boolean
}

type SessionControlCommand = { name: string; args: string }

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

/**
 * Turn a claimed invocation into the body the runtime reads. The source message
 * is the request; any hydrated history follows as compact context.
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

/** Fold the steer text + any swept queued messages into one prompt (most recent last). */
export function buildSteerContent(parts: string[]): string {
  if (parts.length === 1) return parts[0]!
  return ["Handle all of the following together (most recent last):", "", parts.join("\n\n---\n\n")].join("\n")
}

/** Capabilities advertised in hello + presence. Session control only when the connector can drive the runtime. */
export function supportedCapabilitiesFor(sessionControlEnabled: boolean): string[] {
  return sessionControlEnabled ? [...SUPPORTED_CAPABILITIES, SESSION_CONTROL_CAPABILITY] : [...SUPPORTED_CAPABILITIES]
}

/**
 * Capabilities to claim with. Idle: everything we support. Busy (a turn in
 * flight): session-control ONLY, so /stop and /steer jump the queue while a
 * normal active-scratchpad follow-up waits. Empty when busy without runtime
 * control (callers must not claim in that state).
 */
export function claimCapabilitiesFor(busy: boolean, sessionControlEnabled: boolean): string[] {
  if (!busy) return supportedCapabilitiesFor(sessionControlEnabled)
  return sessionControlEnabled ? [SESSION_CONTROL_CAPABILITY] : []
}

export function runtimeCapabilitiesFor(
  runtimeSessionId: string,
  actuator: SessionControlActuator | undefined
): Record<string, unknown> {
  return {
    runtimeSessionId,
    supportsActiveScratchpad: true,
    supportsPersistentSessions: true,
    ...(actuator
      ? {
          supportsSessionControlCommands: true,
          sessionControlCommands: [...actuator.commands],
          ...(actuator.modelSuggestions ? { modelSuggestions: [...actuator.modelSuggestions] } : {}),
          ...(actuator.thinkingLevels ? { thinkingLevels: [...actuator.thinkingLevels] } : {}),
        }
      : {}),
  }
}

interface Inflight {
  invocation: ClaimedInvocation
  // Idle-timeout timer; reset on every sign of life (an interim send, a
  // permission request) so an actively-working turn is never reaped, only a
  // silent one.
  deadline: ReturnType<typeof setTimeout>
  // Count of interim sends posted during this turn. When the idle timeout
  // fires after at least one send, the turn closes silently instead of
  // posting the "ended without a reply" notice — the user already heard from it.
  sentCount: number
  // The reply after attachment uploads, cached when a complete() fails so the
  // retry reuses the same uploads instead of orphaning a fresh copy each time.
  prepared?: { markdown: string; attachmentIds: string[] }
}

export interface RemoteSessionOptions {
  config: RemoteSessionConfig
  client: ThreaClient
  delegate: RemoteSessionDelegate
  runtime: RuntimeDescriptor
  /** Injectable for tests. */
  transport?: BotRuntimeTransport
  log?: (message: string) => void
}

/**
 * A linked Threa scratchpad session for one runtime instance. Owns the whole
 * loop: link creation, claim drain + busy semantics, steer/stop, presence,
 * idle timeouts, claim renewal, and attachment plumbing. Connectors implement
 * `RemoteSessionDelegate` and call `sendInterim`/`reply` from their runtime.
 */
export class RemoteSession {
  private readonly config: RemoteSessionConfig
  private readonly client: ThreaClient
  private readonly delegate: RemoteSessionDelegate
  private readonly runtime: RuntimeDescriptor
  private readonly transport: BotRuntimeTransport
  private readonly log: (message: string) => void
  private link: RuntimeSessionLink | undefined
  private claiming = false
  private stopped = false
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private renewTimer: ReturnType<typeof setInterval> | undefined
  private readonly inflight = new Map<string, Inflight>()
  // The invocation whose turn is executing — the stream a relayed permission
  // prompt belongs in. Set when a non-intercepted invocation is pushed to the
  // runtime. Tracking it beats guessing from the in-flight map, where a
  // follow-up claimed during an open-permission window would otherwise be
  // picked as the (wrong) target.
  private activeTurnStream: string | undefined

  constructor(options: RemoteSessionOptions) {
    this.config = options.config
    this.client = options.client
    this.delegate = options.delegate
    this.runtime = options.runtime
    this.log = options.log ?? (() => undefined)
    this.transport =
      options.transport ??
      new BotRuntimeTransport({
        baseUrl: this.config.baseUrl,
        workspaceId: this.config.workspaceId,
        apiKey: this.config.apiKey,
        hello: {
          instanceId: this.config.instanceId,
          runtimeKind: this.runtime.kind,
          runtimeSessionId: this.config.runtimeSessionId,
          displayName: this.config.displayName,
          supportedCapabilities: supportedCapabilitiesFor(this.sessionControlEnabled),
          capabilities: runtimeCapabilitiesFor(this.config.runtimeSessionId, this.delegate.sessionControl),
          ...(this.runtime.manifest ? { manifest: this.runtime.manifest } : {}),
        },
        callbacks: {
          onInvocationAvailable: () => void this.claimDrain(),
          onBootstrap: (bootstrap) => {
            if (bootstrap.availableInvocations.length > 0 || bootstrap.ownedClaims.length > 0) void this.claimDrain()
          },
        },
        log: this.log,
      })
  }

  private get sessionControlEnabled(): boolean {
    return Boolean(this.delegate.sessionControl)
  }

  /** The stream of the turn the runtime is executing right now, if any. */
  get activeTurnStreamId(): string | undefined {
    return this.activeTurnStream
  }

  /** The scratchpad root stream, once linked. */
  get rootStreamId(): string | undefined {
    return this.link?.rootStreamId
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
      this.log(`linked to scratchpad ${this.config.baseUrl}${this.link.streamUrlPath}`)
      await this.syncPresence()
    } catch (error) {
      this.log(`could not link to Threa (will retry): ${this.summarize(error)}`)
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.renewTimer) clearInterval(this.renewTimer)
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
          errorMessage: this.runtime.shutdownErrorMessage,
        })
      )
    )
  }

  private async verifyPrincipal(): Promise<void> {
    try {
      const me = await this.client.getMe()
      if (me.kind !== "bot") {
        this.log("WARNING: the configured API key is not a bot key (threa_bk_…). Bot-runtime endpoints will reject it.")
      }
    } catch (error) {
      this.log(`could not verify principal (continuing): ${this.summarize(error)}`)
    }
  }

  private async createSession(): Promise<RuntimeSessionLink> {
    return this.client.createSession({
      runtimeKind: this.runtime.kind,
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
        // queued. A connector holding an open intercept window (e.g. a pending
        // tool approval whose verdict arrives as an ordinary message) keeps
        // draining with full caps via `interceptHoldsClaims`. Without runtime
        // control there's nothing to claim while busy: strict one-at-a-time.
        const busy = this.inflight.size > 0 && !this.interceptHoldsClaims
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
      this.log(`claim failed: ${this.summarize(error)}`)
    } finally {
      this.claiming = false
    }
  }

  /**
   * Connector-controlled override: while true, the drain keeps claiming with
   * full capabilities even though a turn is in flight (used for tool-approval
   * verdicts that arrive as ordinary messages and must reach the connector).
   */
  interceptHoldsClaims = false

  private async handleClaimed(invocation: ClaimedInvocation): Promise<void> {
    if (this.delegate.interceptClaimed && (await this.delegate.interceptClaimed(invocation))) {
      await this.client
        .complete(invocation.id, {
          instanceId: this.config.instanceId,
          claimToken: invocation.claimToken,
          noResponse: true,
        })
        .catch((error) => this.log(`intercepted-claim ack failed: ${this.summarize(error)}`))
      return
    }

    const content = await this.buildTurnContent(invocation)
    await this.deliverTurn(invocation, content)
  }

  /** Register an invocation as the in-flight turn and push its content to the runtime. */
  private async deliverTurn(invocation: ClaimedInvocation, content: string): Promise<void> {
    this.inflight.set(invocation.id, {
      invocation,
      deadline: this.scheduleIdleTimeout(invocation.id),
      sentCount: 0,
    })
    // This is the turn the runtime is now executing; a permission prompt it
    // triggers belongs in this invocation's stream.
    this.activeTurnStream = invocation.responseStreamId
    await this.syncPresence()
    await this.transport
      .recordSteps(
        invocation.id,
        invocation.claimToken,
        [{ stepType: "thinking", content: this.runtime.forwardedNote }],
        this.runtime.busyStatusText
      )
      .catch(() => undefined)
    await this.delegate.deliverTurn({
      invocationId: invocation.id,
      streamId: invocation.responseStreamId,
      sourceMessageId: invocation.sourceMessageId,
      content,
    })
  }

  // --- Session control (steer / stop / delegated commands) -------------------

  private async handleSessionControl(invocation: ClaimedInvocation): Promise<void> {
    const command = parseSessionControlCommand(invocation)
    if (!command) {
      await this.failInvocation(invocation, "Missing session-control command metadata")
      return
    }
    const actuator = this.delegate.sessionControl
    if (!actuator) {
      await this.failInvocation(invocation, "Session control is not available for this runtime")
      return
    }
    try {
      switch (command.name) {
        case "stop":
          return await this.runStop(invocation, actuator)
        case "steer":
          return await this.runSteer(invocation, actuator, command.args)
        default: {
          if (!actuator.commands.includes(command.name)) {
            await this.failInvocation(invocation, `Unsupported session-control command: ${command.name}`)
            return
          }
          const outcome = await actuator.runCommand(command.name, command.args)
          await this.completeAck(invocation, outcome.message)
        }
      }
    } catch (error) {
      await this.failInvocation(invocation, this.summarize(error))
    }
  }

  private async runStop(invocation: ClaimedInvocation, actuator: SessionControlActuator): Promise<void> {
    // If the interrupt can't be sent (runtime control lost), the runtime is
    // still running — don't close its in-flight turns as if we stopped them.
    if (!actuator.interrupt()) {
      await this.completeAck(invocation, "Could not send the interrupt (runtime control unavailable).")
      return
    }
    const hadTurn = this.inflight.size > 0
    await this.completeInterruptedTurns("Stopped by /stop.")
    await this.completeAck(invocation, hadTurn ? "Stopped the current turn." : "Sent an interrupt to the session.")
    await this.syncPresence()
  }

  /**
   * Interrupt the running turn, then fold the steer text + any messages queued
   * while the runtime was busy into ONE combined turn (mirrors Pi: N messages →
   * 1 response). The interrupt is the only actuation; the combined content
   * round-trips through the normal delivery path so the runtime replies to it.
   */
  private async runSteer(invocation: ClaimedInvocation, actuator: SessionControlActuator, text: string): Promise<void> {
    // If the interrupt can't be sent, bail before any destructive side-effect —
    // don't close the running turn or deliver the steer as a second concurrent
    // turn against a runtime we couldn't actually interrupt.
    if (!actuator.interrupt()) {
      await this.completeAck(
        invocation,
        "Could not interrupt the session (runtime control unavailable); steer not delivered."
      )
      return
    }
    await new Promise((resolve) => setTimeout(resolve, STEER_SETTLE_MS))
    // Always leave a visible marker carrying the steer text: a bare
    // "Superseded by /steer." followed by working silence reads as "the steer
    // was lost". The note doubles as the delivery acknowledgement.
    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text
    await this.completeInterruptedTurns(
      preview ? `Superseded by /steer — now handling: “${preview}”` : "Superseded by /steer.",
      { alwaysNote: true }
    )

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
      await this.completeAck(invocation, "Interrupted the session; nothing pending to steer with.")
      await this.syncPresence()
      return
    }

    await this.deliverTurn(invocation, buildSteerContent(parts))
  }

  private async completeAck(invocation: ClaimedInvocation, markdown: string): Promise<void> {
    await this.client
      .complete(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        finalMessageMarkdown: markdown,
        metadata: { "remote.invocationId": invocation.id, "remote.sessionControl": "true" },
      })
      .catch((error) => this.log(`session-control ack failed: ${this.summarize(error)}`))
  }

  private async completeNoResponse(invocation: ClaimedInvocation): Promise<void> {
    await this.client
      .complete(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        noResponse: true,
        metadata: { "remote.invocationId": invocation.id, "remote.steered": "true" },
      })
      .catch((error) => this.log(`steered close failed: ${this.summarize(error)}`))
  }

  private async failInvocation(invocation: ClaimedInvocation, errorMessage: string): Promise<void> {
    await this.client
      .fail(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        errorMessage: errorMessage.slice(0, 1000),
      })
      .catch((error) => this.log(`session-control fail failed: ${this.summarize(error)}`))
  }

  /**
   * Close every in-flight turn that an interrupt just aborted, so none
   * idle-hangs for an hour. By default a turn that already posted interim
   * messages closes silently (the user has heard from it); `alwaysNote` posts
   * the note regardless — steers use it so delivery is always visible.
   */
  private async completeInterruptedTurns(note: string, opts: { alwaysNote?: boolean } = {}): Promise<void> {
    // Clear every entry's timer and drop it from the map BEFORE the first await.
    // If we cleared-and-completed one at a time, a sibling's idle-timeout could
    // fire at a `complete()` yield point, find itself still in the map, and
    // complete itself — then this loop double-completes it.
    const entries = [...this.inflight]
    for (const [id, entry] of entries) {
      this.clearInflight(id)
      if (this.activeTurnStream === entry.invocation.responseStreamId) this.activeTurnStream = undefined
    }
    await Promise.all(
      entries.map(([id, entry]) => {
        const body =
          entry.sentCount > 0 && !opts.alwaysNote ? { noResponse: true } : { finalMessageMarkdown: `_${note}_` }
        return this.client
          .complete(id, {
            instanceId: this.config.instanceId,
            claimToken: entry.invocation.claimToken,
            ...body,
            metadata: { "remote.invocationId": id, "remote.interrupted": "true" },
          })
          .catch((error) => this.log(`interrupted-turn close failed: ${this.summarize(error)}`))
      })
    )
  }

  /** The prompt + history the runtime reads, with any downloaded attachments appended as a manifest. */
  private async buildTurnContent(invocation: ClaimedInvocation): Promise<string> {
    const base = formatInvocationContent(invocation)
    // Best-effort: a discovery/download failure (e.g. a key without
    // attachments:read) must never block the prompt from reaching the runtime.
    try {
      const downloaded = await downloadInboundAttachments(this.client, {
        streamId: invocation.activeStreamId,
        sourceMessageId: invocation.sourceMessageId,
        contextMessageIds: (invocation.context?.messages ?? []).map((message) => message.messageId),
        invocationId: invocation.id,
        cwd: process.cwd(),
        scanLimit: ATTACHMENT_SCAN_LIMIT,
        log: this.log,
      })
      const manifest = formatInboundAttachmentManifest(downloaded)
      return manifest ? `${base}\n\n${manifest}` : base
    } catch (error) {
      this.log(`inbound attachment scan failed: ${this.summarize(error)}`)
      return base
    }
  }

  // --- Interim + final output ------------------------------------------------

  /** Post a progress message into the turn's stream without closing the request. */
  async sendInterim(invocationId: string, text: string): Promise<SendResult> {
    const entry = this.inflight.get(invocationId)
    if (!entry) {
      return {
        ok: false,
        message: `No open request with invocation_id ${invocationId} — interim messages need an open request (it may have been answered or closed).`,
      }
    }
    // Stable per-send client id so a retry after a network failure dedupes
    // instead of double-posting; commit the counter only once the post lands.
    const seq = entry.sentCount + 1
    try {
      const { markdown } = await uploadReplyAttachments(this.client, text, process.cwd())
      await this.client.sendMessage(entry.invocation.responseStreamId, {
        content: markdown,
        clientMessageId: `remote-send-${invocationId}-${seq}`,
        metadata: { "remote.invocationId": invocationId, "remote.interim": "true" },
      })
    } catch (error) {
      return { ok: false, message: `Failed to post message to Threa: ${this.summarize(error)}`, retryable: true }
    }
    // The idle timer can fire during the awaits above — unlike reply(), which
    // clears its deadline up front, this path must keep the turn open and can't.
    // If it fired, onReplyTimeout already removed this entry and completed the
    // turn, so the message we just posted landed on a closed turn. Report that
    // instead of a clean "sent", so the runtime doesn't then try to reply to a
    // request that's gone.
    const live = this.inflight.get(invocationId)
    if (!live) {
      return {
        ok: false,
        message: `Message posted, but request ${invocationId} had already closed for inactivity — it is complete; do not reply to it.`,
      }
    }
    live.sentCount = seq
    // A send is a sign of life: push the idle timeout out so a turn that keeps
    // posting progress is never force-closed.
    this.touchIdleTimeout(invocationId)
    return { ok: true, message: "sent" }
  }

  /** Post the final answer and close the request. */
  async reply(invocationId: string, text: string): Promise<SendResult> {
    const entry = this.inflight.get(invocationId)
    if (!entry) {
      return {
        ok: false,
        message: `No open request with invocation_id ${invocationId} (already answered, expired, or unknown).`,
      }
    }
    // Clear the entry (and its deadline) before awaiting complete(), so the
    // reply-timeout can't fire mid-await and double-complete the invocation.
    this.clearInflight(invocationId)
    // Reuse a prior attempt's uploads (cached on a complete() failure) so a
    // retry doesn't re-upload every attachment and orphan the first copy.
    let prepared = entry.prepared
    try {
      if (!prepared) {
        const { markdown, uploaded } = await uploadReplyAttachments(this.client, text, process.cwd())
        prepared = { markdown, attachmentIds: uploaded.map((a) => a.id) }
      }
      await this.client.complete(invocationId, {
        instanceId: this.config.instanceId,
        claimToken: entry.invocation.claimToken,
        finalMessageMarkdown: prepared.markdown,
        metadata: {
          "remote.invocationId": invocationId,
          "remote.instanceId": this.config.instanceId,
          ...(prepared.attachmentIds.length > 0 && { "remote.attachmentIds": prepared.attachmentIds.join(",") }),
        },
      })
    } catch (error) {
      // Re-arm (with a fresh deadline) so the runtime can retry the reply. Safe
      // from double-complete because the original deadline was already cleared.
      this.inflight.set(invocationId, {
        invocation: entry.invocation,
        deadline: this.scheduleIdleTimeout(invocationId),
        sentCount: entry.sentCount,
        prepared,
      })
      await this.syncPresence()
      return {
        ok: false,
        message: `Failed to post reply to Threa (will stay open for retry): ${this.summarize(error)}`,
        retryable: true,
      }
    }
    if (this.activeTurnStream === entry.invocation.responseStreamId) this.activeTurnStream = undefined
    await this.syncPresence()
    return { ok: true, message: "sent" }
  }

  /** Post a message into a stream outside the turn flow (e.g. a relayed approval prompt). */
  async postToStream(
    streamId: string,
    body: { content: string; clientMessageId?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    await this.client.sendMessage(streamId, body)
  }

  /** Reset idle timeouts for every in-flight turn in a stream (a pending approval is a sign of life). */
  keepAlive(streamId: string): void {
    for (const [id, entry] of this.inflight) {
      if (entry.invocation.responseStreamId === streamId) this.touchIdleTimeout(id)
    }
  }

  /** Fired when a turn goes idle (no reply/send/keep-alive) for the whole idle window. */
  private async onReplyTimeout(invocationId: string): Promise<void> {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    this.clearInflight(invocationId)
    // If the turn already posted interim messages, the user has heard from it —
    // close silently rather than posting a misleading "no reply" notice.
    const closeBody =
      entry.sentCount > 0
        ? { noResponse: true }
        : { finalMessageMarkdown: "_The session ended the turn without sending a reply._" }
    await this.client
      .complete(invocationId, {
        instanceId: this.config.instanceId,
        claimToken: entry.invocation.claimToken,
        ...closeBody,
        metadata: { "remote.invocationId": invocationId, "remote.timedOut": "true" },
      })
      .catch((error) => this.log(`timeout completion failed: ${this.summarize(error)}`))
    if (this.activeTurnStream === entry.invocation.responseStreamId) this.activeTurnStream = undefined
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

  /** Reset an in-flight turn's idle timeout after a sign of life. */
  private touchIdleTimeout(invocationId: string): void {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    clearTimeout(entry.deadline)
    entry.deadline = this.scheduleIdleTimeout(invocationId)
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
              if (this.activeTurnStream === entry.invocation.responseStreamId) {
                this.activeTurnStream = undefined
              }
              this.clearInflight(id)
              void this.syncPresence()
            }
          })
          .catch((error) => this.log(`renew ${id} failed: ${this.summarize(error)}`))
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
      .updatePresence(this.presenceBody(busy ? "busy" : "available", busy ? this.runtime.busyStatusText : undefined))
      .catch(() => undefined)
  }

  private presenceBody(status: "available" | "busy" | "offline", statusText?: string): Record<string, unknown> {
    return {
      runtimeKind: this.runtime.kind,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      displayName: this.config.displayName,
      status,
      acceptingInvocations: status === "available",
      // Full capabilities on EVERY presence update: the server replaces stored
      // capabilities on a presence:update (it doesn't merge), so omitting the
      // session-control keys here would wipe what bot:hello advertised.
      capabilities: runtimeCapabilitiesFor(this.config.runtimeSessionId, this.delegate.sessionControl),
      ...(statusText ? { statusText } : {}),
    }
  }

  private claimBody(busy: boolean): Record<string, unknown> {
    return {
      runtimeKind: this.runtime.kind,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      supportedCapabilities: claimCapabilitiesFor(busy, this.sessionControlEnabled),
      claimTtlSeconds: CLAIM_TTL_SECONDS,
    }
  }

  private summarize(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200)
  }
}
