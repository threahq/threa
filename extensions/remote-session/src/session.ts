import { homedir } from "node:os"
import { join } from "node:path"
import {
  BikKeystore,
  BotRuntimeTransport,
  mintStreamKeyWraps,
  openSealedTurnContext,
  parseSealedTurnContext,
  scrubSealedError,
  sealReply,
  sealStep,
  type BotRuntimeHello,
  type SealedReplyBody,
  type StepFrame,
} from "@threa/bot-runtime-client"
import {
  downloadInboundAttachments,
  extractAttachmentDirectives,
  formatInboundAttachmentManifest,
  uploadReplyAttachments,
} from "./attachments"
import { sanitizeId, type RemoteSessionConfig } from "./identity"
import {
  ThreaApiError,
  ThreaClient,
  type ClaimedInvocation,
  type ExternalHistoryMessage,
  type RuntimeSessionLink,
} from "./client"

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
// Server-side cap on frames per bot:invocation:steps call (`stepsFrameSchema`
// in apps/backend/src/features/bot-runtimes/socket-handler.ts).
const MAX_STEP_FRAMES_PER_CALL = 50
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
  /**
   * The linked scratchpad was archived (the server already ended the session
   * link). Called after the SDK has gone offline and failed its in-flight
   * turns; the connector finishes the wind-down — the Claude channel pushes
   * its branch and kills its own tmux window, so this hook may never return.
   */
  onArchived?: (payload: { rootStreamId: string }) => Promise<void> | void
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
  // A sealed interim whose POST failed, cached so the retry re-sends the SAME
  // sealed body (same message id) and the server's idempotency key dedupes it —
  // a fresh seal per attempt would double-post on retry.
  pendingSealedInterim?: { seq: number; body: SealedReplyBody }
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
  private readonly bik: BikKeystore
  private readonly hello: BotRuntimeHello
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
    this.bik = new BikKeystore({
      path: this.config.bikPath ?? join(homedir(), ".threa", `bik-${sanitizeId(this.runtime.kind)}.json`),
      log: this.log,
    })
    // The transport re-sends this exact object on every reconnect hello, so the
    // BIK fields assigned into it at start() (after ensure()) ride every one.
    this.hello = {
      instanceId: this.config.instanceId,
      runtimeKind: this.runtime.kind,
      runtimeSessionId: this.config.runtimeSessionId,
      displayName: this.config.displayName,
      supportedCapabilities: supportedCapabilitiesFor(this.sessionControlEnabled),
      capabilities: runtimeCapabilitiesFor(this.config.runtimeSessionId, this.delegate.sessionControl),
      ...(this.runtime.manifest ? { manifest: this.runtime.manifest } : {}),
    }
    this.transport =
      options.transport ??
      new BotRuntimeTransport({
        baseUrl: this.config.baseUrl,
        workspaceId: this.config.workspaceId,
        apiKey: this.config.apiKey,
        hello: this.hello,
        callbacks: {
          onInvocationAvailable: () => void this.claimDrain(),
          onBootstrap: (bootstrap) => {
            if (bootstrap.availableInvocations.length > 0 || bootstrap.ownedClaims.length > 0) void this.claimDrain()
          },
          onSessionArchived: (payload) => void this.handleSessionArchived(payload),
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
    // BIK before the first hello/presence write: the server's instance upsert
    // overwrites the stored key by default, so a write without these fields
    // clears the registration and breaks sealed-claim wrap coverage.
    await this.bik.ensure()
    Object.assign(this.hello, this.bik.presenceFields())
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
          // The shutdown message is a fixed string (never turn content), so it
          // is safe on sealed turns too.
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
    const e2e = this.config.e2e ? await this.resolveE2eCreateBlock() : undefined
    const link = await this.client.createSession({
      runtimeKind: this.runtime.kind,
      instanceId: this.config.instanceId,
      runtimeSessionId: this.config.runtimeSessionId,
      displayName: this.config.displayName,
      localCwd: process.cwd(),
      ...(this.config.defaultLabel && { labelName: this.config.defaultLabel }),
      ...(e2e ? { e2e: { ownerKeyId: e2e.ownerKeyId } } : {}),
    })
    if (this.config.e2e && link.e2eEnabled !== true) {
      // A resume of a pre-existing PLAINTEXT scratchpad — nothing to provision,
      // but the user asked for encryption, so say why they aren't getting it.
      this.log(
        `WARNING: e2e is enabled but the resumed scratchpad ${link.rootStreamId} is plaintext ` +
          "(it predates the setting). Archive it to get a fresh encrypted scratchpad on the next start."
      )
      return link
    }
    if (e2e && link.e2eEnabled === true) {
      await this.provisionE2eStreamKey(link, e2e)
    }
    return link
  }

  /**
   * Resolve the owner-key half of an E2E create. Throws with an actionable
   * message when the owner has no encryption key or this install has no BIK —
   * ensureLink logs it and retries each poll tick, so the session self-heals
   * the moment the owner sets up encryption.
   */
  private async resolveE2eCreateBlock(): Promise<{ ownerKeyId: string; ownerPublicKey: string }> {
    const bik = await this.bik.ensure()
    if (!bik) throw new Error("e2e is enabled but this install could not create a bot identity key (see earlier log)")
    let ownerKey: { keyId: string; publicKey: string }
    try {
      ownerKey = await this.client.getOwnerE2eKey()
    } catch (error) {
      if (error instanceof ThreaApiError && error.status === 404) {
        throw new Error(
          "e2e is enabled but the bot owner has not set up encryption in Threa yet — " +
            "set an encryption passphrase in the app, then this session will link encrypted."
        )
      }
      throw error
    }
    return { ownerKeyId: ownerKey.keyId, ownerPublicKey: ownerKey.publicKey }
  }

  /**
   * Phase two of the encrypted create: mint the generation-0 stream key, wrap
   * it to the owner's UIK + this install's BIK, and store the wraps. Until this
   * lands nobody can seal into the scratchpad (INV-E1 keeps plaintext out), so
   * a failure retries in place; a 409 means an earlier attempt landed.
   */
  private async provisionE2eStreamKey(
    link: RuntimeSessionLink,
    e2e: { ownerKeyId: string; ownerPublicKey: string }
  ): Promise<void> {
    const bik = this.bik.current
    if (!bik) throw new Error("BIK disappeared mid-provisioning")
    const { wraps } = await mintStreamKeyWraps({
      streamId: link.rootStreamId,
      keyGeneration: 0,
      recipients: [
        { recipientKind: "user", recipientKeyId: e2e.ownerKeyId, publicKeyBase64: e2e.ownerPublicKey },
        { recipientKind: "bot", recipientKeyId: bik.publicKeyId, publicKeyBase64: bik.publicKeyBase64 },
      ],
    })
    for (let attempt = 1; ; attempt++) {
      try {
        await this.client.provisionStreamKeyWraps(link.rootStreamId, { keyGeneration: 0, wraps })
        this.log(`provisioned encrypted scratchpad ${link.rootStreamId} (gen 0, owner + BIK wraps)`)
        return
      } catch (error) {
        // 409: a previous attempt (this process or a crashed predecessor) landed.
        if (error instanceof ThreaApiError && error.status === 409) return
        if (attempt >= 3) throw error
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
      }
    }
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
        const invocation = await this.claimNext(busy)
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

  /**
   * Claim one invocation and, when it arrives sealed, hydrate it in place: open
   * the SSK wraps with this install's BIK, decrypt the trigger + history, and
   * stash the {@link SealingState} every reply/step seals with. From here on the
   * invocation looks like a plaintext one to the rest of the loop — only the
   * write paths branch on `sealing`. A hydration failure fails the invocation
   * loudly (scrubbed reason) and reports "nothing claimed" rather than throwing
   * the drain into a TTL-recycle loop.
   */
  private async claimNext(busy: boolean): Promise<ClaimedInvocation | null> {
    const invocation = await this.client.claim(this.claimBody(busy))
    if (!invocation || invocation.sealedContext === undefined) return invocation
    const fail = async (reason: string): Promise<null> => {
      this.log(`sealed claim ${invocation.id} unusable: ${reason}`)
      await this.client
        .fail(invocation.id, {
          instanceId: this.config.instanceId,
          claimToken: invocation.claimToken,
          errorMessage: `Sealed turn failed: ${reason}`.slice(0, 200),
        })
        .catch(() => undefined)
      return null
    }
    const sealed = parseSealedTurnContext(invocation.sealedContext)
    if (!sealed) return fail("malformed sealedContext")
    const identity = await this.bik.ensure()
    if (!identity) return fail("no bot identity key")
    try {
      // Wraps and the message AAD bind to the ROOT stream that owns the E2E key.
      const opened = await openSealedTurnContext({ sealed, identity, streamId: invocation.rootStreamId })
      const messages: ExternalHistoryMessage[] = opened.history.map((item) => ({
        messageId: `sealed-${item.sequence}`,
        role: item.role,
        authorId: "",
        authorType: item.role === "assistant" ? "bot" : "user",
        contentMarkdown: item.contentMarkdown,
        createdAt: "",
      }))
      return {
        ...invocation,
        sealedContext: undefined,
        promptMarkdown: opened.promptMarkdown,
        sealing: opened.sealing,
        ...(messages.length > 0 ? { context: { kind: "inline" as const, messages } } : {}),
      }
    } catch (error) {
      return fail(scrubSealedError(error))
    }
  }

  private async handleClaimed(invocation: ClaimedInvocation): Promise<void> {
    if (this.delegate.interceptClaimed && (await this.delegate.interceptClaimed(invocation))) {
      await this.completeTurn(invocation, { noResponse: true }).catch((error) =>
        this.log(`intercepted-claim ack failed: ${this.summarize(error)}`)
      )
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
    await this.recordForwardedStep(invocation).catch(() => undefined)
    await this.delegate.deliverTurn({
      invocationId: invocation.id,
      streamId: invocation.responseStreamId,
      sourceMessageId: invocation.sourceMessageId,
      content,
    })
  }

  /** The turn-handed-to-runtime trace note — sealed under the stream key on an E2E turn. */
  private async recordForwardedStep(invocation: ClaimedInvocation): Promise<void> {
    if (invocation.sealing) {
      const frame = await sealStep(invocation.sealing, "thinking", this.runtime.forwardedNote)
      await this.transport.recordSealedSteps(invocation.id, invocation.sealing.callbackToken, [frame])
      return
    }
    await this.transport.recordSteps(
      invocation.id,
      invocation.claimToken,
      [{ stepType: "thinking", content: this.runtime.forwardedNote }],
      this.runtime.busyStatusText
    )
  }

  /**
   * Close one turn — the single chokepoint that routes a completion to the
   * plaintext `/complete` or, for a sealed turn, seals the markdown under the
   * stream key and posts `/sealed-complete` (which carries no metadata; the
   * sealed grant is the context). Every close path (reply, no-response,
   * interrupt notes, idle timeout, intercepted-claim ack) funnels through here
   * so none can leak plaintext into an E2E stream.
   */
  private async completeTurn(
    invocation: ClaimedInvocation,
    body: { markdown?: string; noResponse?: true; metadata?: Record<string, unknown> }
  ): Promise<void> {
    if (invocation.sealing) {
      if (body.markdown) {
        const reply = await sealReply(invocation.sealing, body.markdown)
        await this.client.completeSealed(invocation.id, invocation.sealing.callbackToken, { reply })
      } else {
        await this.client.completeSealed(invocation.id, invocation.sealing.callbackToken, { noResponse: true })
      }
      return
    }
    await this.client.complete(invocation.id, {
      instanceId: this.config.instanceId,
      claimToken: invocation.claimToken,
      ...(body.markdown ? { finalMessageMarkdown: body.markdown } : { noResponse: true }),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    })
  }

  /**
   * Strip `THREA_ATTACH:` directives out of sealed output — uploading the bytes
   * would push plaintext file content through the attachment store, outside the
   * E2E boundary. A note replaces them so the user knows why the file is missing.
   */
  private stripSealedAttachmentDirectives(text: string): string {
    const extracted = extractAttachmentDirectives(text)
    if (extracted.paths.length === 0) return text
    const note = `_${extracted.paths.length} local attachment${extracted.paths.length === 1 ? "" : "s"} not uploaded — attachments aren't supported in encrypted scratchpads yet._`
    return [extracted.markdown, note].filter(Boolean).join("\n\n")
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
      const extra = await this.claimNext(false).catch(() => null)
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
    try {
      await this.client.complete(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        finalMessageMarkdown: markdown,
        metadata: { "remote.invocationId": invocation.id, "remote.sessionControl": "true" },
      })
    } catch (error) {
      // A session-control invocation on an E2E scratchpad claims plaintext (no
      // sealed session exists for it), so its markdown ack is rejected by the
      // sealed-timeline gate (400). Close silently instead — the command still
      // executed and the command:completed event carries the feedback; a sealed
      // ack wire is follow-up work.
      if (error instanceof ThreaApiError && error.status === 400) {
        await this.completeTurn(invocation, { noResponse: true }).catch((inner) =>
          this.log(`session-control silent ack failed: ${this.summarize(inner)}`)
        )
        return
      }
      this.log(`session-control ack failed: ${this.summarize(error)}`)
    }
  }

  private async completeNoResponse(invocation: ClaimedInvocation): Promise<void> {
    await this.completeTurn(invocation, {
      noResponse: true,
      metadata: { "remote.invocationId": invocation.id, "remote.steered": "true" },
    }).catch((error) => this.log(`steered close failed: ${this.summarize(error)}`))
  }

  private async failInvocation(invocation: ClaimedInvocation, errorMessage: string): Promise<void> {
    // A sealed turn's error text could echo decrypted content — scrub to a
    // generic reason (the /fail wire itself is shared, model A).
    const scrubbed = invocation.sealing ? "Sealed turn failed" : errorMessage.slice(0, 1000)
    await this.client
      .fail(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        errorMessage: scrubbed,
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
        const silent = entry.sentCount > 0 && !opts.alwaysNote
        return this.completeTurn(entry.invocation, {
          ...(silent ? { noResponse: true as const } : { markdown: `_${note}_` }),
          metadata: { "remote.invocationId": id, "remote.interrupted": "true" },
        }).catch((error) => this.log(`interrupted-turn close failed: ${this.summarize(error)}`))
      })
    )
  }

  /** The prompt + history the runtime reads, with any downloaded attachments appended as a manifest. */
  private async buildTurnContent(invocation: ClaimedInvocation): Promise<string> {
    const base = formatInvocationContent(invocation)
    // A sealed turn's context is what hydration decrypted; the plaintext
    // message list only holds ciphertext placeholders and sealed attachments
    // aren't supported yet, so there is nothing to scan.
    if (invocation.sealing) return base
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
      if (entry.invocation.sealing) {
        // Sealed turn: seal the interim under the stream key and post it via
        // the claim-bound sealed-messages callback. No attachment uploads —
        // directives are stripped with a note (plaintext bytes must not leave
        // the E2E boundary). A retry after a failed POST reuses the cached
        // sealed body so the same message id dedupes server-side.
        const sealedBody =
          entry.pendingSealedInterim?.seq === seq
            ? entry.pendingSealedInterim.body
            : await sealReply(
                entry.invocation.sealing,
                this.stripSealedAttachmentDirectives(text.trim() || "(empty message)")
              )
        entry.pendingSealedInterim = { seq, body: sealedBody }
        await this.client.sendSealedMessage(invocationId, entry.invocation.sealing.callbackToken, sealedBody)
        entry.pendingSealedInterim = undefined
      } else {
        const { markdown } = await uploadReplyAttachments(this.client, text, process.cwd())
        await this.client.sendMessage(entry.invocation.responseStreamId, {
          content: markdown,
          clientMessageId: `remote-send-${invocationId}-${seq}`,
          metadata: { "remote.invocationId": invocationId, "remote.interim": "true" },
        })
      }
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
        if (entry.invocation.sealing) {
          // No uploads on a sealed turn — strip directives with a note instead.
          prepared = {
            markdown: this.stripSealedAttachmentDirectives(text.trim() || "Done."),
            attachmentIds: [],
          }
        } else {
          const { markdown, uploaded } = await uploadReplyAttachments(this.client, text, process.cwd())
          prepared = { markdown, attachmentIds: uploaded.map((a) => a.id) }
        }
      }
      await this.completeTurn(entry.invocation, {
        markdown: prepared.markdown,
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

  /**
   * Record trace steps against an in-flight turn. Fire-and-forget: a failed
   * frame is logged and dropped, not retried — steps are ephemeral progress,
   * not state. Returns false when the invocation is no longer in flight
   * (answered, expired, superseded), which a transcript tailer uses as its
   * stop signal. Frames must arrive already redacted (or full, on a sealed
   * turn — the tailer decides); this method ships them verbatim, sealing each
   * one under the stream key when the turn is sealed so plaintext step
   * content never leaves the machine on an E2E scratchpad.
   */
  async recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean> {
    const entry = this.inflight.get(invocationId)
    if (!entry) return false
    // The server rejects >50 frames per steps call (plaintext and sealed alike),
    // so a large batch (e.g. a transcript replay after late binding) ships in chunks.
    for (let start = 0; start < frames.length; start += MAX_STEP_FRAMES_PER_CALL) {
      const chunk = frames.slice(start, start + MAX_STEP_FRAMES_PER_CALL)
      if (entry.invocation.sealing) {
        // Sealed turn: seal each frame under the stream key and ship on the
        // sealed wire. No statusText — the sealed wire deliberately carries
        // none (a plaintext status derived from sealed content would leak).
        const sealing = entry.invocation.sealing
        try {
          const sealedFrames = await Promise.all(chunk.map((frame) => sealStep(sealing, frame.stepType, frame.content)))
          await this.transport.recordSealedSteps(invocationId, sealing.callbackToken, sealedFrames)
        } catch (error) {
          this.log(`recordSteps (sealed) failed: ${this.summarize(error)}`)
        }
      } else {
        await this.transport
          .recordSteps(invocationId, entry.invocation.claimToken, chunk, statusText ?? this.runtime.busyStatusText)
          .catch((error) => this.log(`recordSteps failed: ${this.summarize(error)}`))
      }
      // The turn can close during an awaited send (reply, /stop, idle timeout)
      // — exactly the long multi-chunk replays this loop exists for. Recheck so
      // the returned boolean stays an honest stop signal for the tailer.
      if (!this.inflight.has(invocationId)) return false
    }
    return true
  }

  /**
   * Post a message into a stream outside the turn flow (e.g. a relayed approval
   * prompt). On a sealed stream the plaintext message API would rightly reject
   * it, so when an in-flight SEALED turn is executing in that stream the text is
   * sealed under its stream key and posted via the claim-bound sealed-messages
   * callback instead — which is exactly the permission-relay case (the prompt
   * fires mid-turn).
   */
  async postToStream(
    streamId: string,
    body: { content: string; clientMessageId?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const sealedEntry = [...this.inflight.values()].find(
      (entry) => entry.invocation.responseStreamId === streamId && entry.invocation.sealing
    )
    if (sealedEntry?.invocation.sealing) {
      const sealed = await sealReply(sealedEntry.invocation.sealing, body.content)
      await this.client.sendSealedMessage(
        sealedEntry.invocation.id,
        sealedEntry.invocation.sealing.callbackToken,
        sealed
      )
      return
    }
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
    await this.completeTurn(entry.invocation, {
      ...(entry.sentCount > 0
        ? { noResponse: true as const }
        : { markdown: "_The session ended the turn without sending a reply._" }),
      metadata: { "remote.invocationId": invocationId, "remote.timedOut": "true" },
    }).catch((error) => this.log(`timeout completion failed: ${this.summarize(error)}`))
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

  /**
   * The linked scratchpad was archived. The server has already ended the
   * session link, so no more work can arrive; go offline (shutdown also fails
   * any in-flight turn) and hand the connector the final word. Scoped to this
   * session: the event is room-targeted, but a runtime that re-registered
   * under a new session id must not die to a stale event for the old one.
   */
  private async handleSessionArchived(payload: unknown): Promise<void> {
    const data = (payload ?? {}) as { runtimeSessionId?: unknown; rootStreamId?: unknown }
    if (typeof data.runtimeSessionId === "string" && data.runtimeSessionId !== this.config.runtimeSessionId) return
    if (this.stopped) return
    const rootStreamId = typeof data.rootStreamId === "string" ? data.rootStreamId : (this.link?.rootStreamId ?? "")
    this.log(`scratchpad ${rootStreamId} archived — winding down`)
    await this.shutdown()
    try {
      await this.delegate.onArchived?.({ rootStreamId })
    } catch (error) {
      this.log(`onArchived hook failed: ${this.summarize(error)}`)
    }
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
      // The BIK must ride every presence write too — the upsert overwrites the
      // stored key, so omitting it here would clear what hello registered.
      ...this.bik.presenceFields(),
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
