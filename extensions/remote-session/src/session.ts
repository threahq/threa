import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  ArchiveGraceController,
  BikKeystore,
  WS_BACKSTOP_POLL_MS,
  BotRuntimeTransport,
  mintStreamKeyWraps,
  openSealedAck,
  openSealedTurnContext,
  parseSealedAckContext,
  parseSealedTurnContext,
  scrubSealedError,
  sealReply,
  sealStep,
  type BotRuntimeHello,
  type DelegationAvailableNudge,
  type InvocationInputUpdate,
  type ObservedClaimHandle,
  type SealedReplyBody,
  type StepFrame,
} from "@threahq/bot-runtime-client"
import {
  downloadInboundAttachments,
  downloadSealedInboundAttachments,
  formatInboundAttachmentManifest,
  selectSealedInboundRefs,
  uploadReplyAttachments,
  uploadSealedReplyAttachments,
} from "./attachments"
import { sanitizeId, type RemoteSessionConfig } from "./identity"
import {
  ThreaApiError,
  ThreaClient,
  type ClaimedInvocation,
  type ExternalHistoryMessage,
  type RuntimeSessionLink,
} from "./client"
import { RouteRevokedError, TurnRoute, type CloseRequest, type PostIntent, type PreparedClose } from "./turn-route"

export const SUPPORTED_CAPABILITIES = ["active-scratchpad", "mentionable"] as const
export const SESSION_CONTROL_CAPABILITY = "session-control"
// Mirror Pi's STEER_DRAIN_LIMIT: how many queued messages a single /steer folds
// into one combined turn before stopping (a backstop, not an expected count).
const STEER_DRAIN_LIMIT = 10
/** Milliseconds to wait after an interrupt before delivering the steer turn, so the runtime has returned to idle. */
export const STEER_SETTLE_MS = 250

const CLAIM_TTL_SECONDS = 120
// With NO socket, the poll is the only delivery path, but a fast fixed cadence
// is how a single wedged session burned ~29k billed edge requests/day. Back off
// empty ticks exponentially from config.pollMs to this cap; a claimed turn or a
// socket reconnect resets to the fast cadence. Worst-case degraded latency for
// a socketless session is one cap interval.
const NO_SOCKET_POLL_CAP_MS = 2 * 60 * 1000
// Harness preflight can take 10s and replacement verification up to 15s.
export const RECONNECT_HANDOFF_FALLBACK_MS = 30_000
const MAX_CLAIMS_PER_DRAIN = 20
// Server-side cap on frames per bot:invocation:steps call (`stepsFrameSchema`
// in apps/backend/src/features/bot-runtimes/socket-handler.ts).
const MAX_STEP_FRAMES_PER_CALL = 50
const MAX_CONTEXT_MESSAGES = 12
const MAX_MESSAGE_CHARS = 2_000
// Recent messages to scan for inbound attachments. The trigger message is always
// the newest, so this comfortably covers it plus the history the agent is shown.
const ATTACHMENT_SCAN_LIMIT = 30
// Bounds retained stream keys and callback tokens while covering several hours of typical channel use.
export const COMPLETED_TURN_MEMORY = 64
// These 4xx responses can clear on retry; other 4xx responses permanently revoke the route.
const RETRYABLE_POST_STATUSES = new Set([408, 425, 429])

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
  /**
   * The turn arrived sealed (E2EE): everything the connector records for it is
   * ciphertext to the server, so a transcript tracer may run in full-detail
   * mode — the point of sealed steps is more for the owner, nothing for the server.
   */
  sealed: boolean
}

/**
 * How a connector drives its runtime for session control. `stop` and `steer`
 * are actuated by the SDK itself (they manipulate SDK-owned turn state) using
 * `interrupt()`/`steer()`; every other advertised command is routed to
 * `runCommand`, which returns the user-facing ack markdown.
 */
export interface SessionControlInvocationContext {
  rootStreamId: string
  /** The message the user typed the command into — what a command anchors its thread on. */
  sourceMessageId: string
}

export interface SessionControlActuator {
  /** Command names to advertise (must be Threa catalog names, e.g. "model", "thinking", "compact", "run", "reload", "steer", "stop"). */
  commands: readonly string[]
  /** Model options for the composer's arg picker. */
  modelSuggestions?: readonly ModelSuggestionInfo[]
  /** Levels for the canonical /thinking command's arg picker. */
  thinkingLevels?: readonly string[]
  /** Interrupt the runtime's current turn. False = control lost (e.g. pane gone). */
  interrupt(): boolean
  /**
   * Fold text into the RUNNING turn without interrupting it — the runtime's
   * native mid-turn steering (typing into Claude Code while it works). When
   * present and a turn is in flight, /steer steers in place: the running
   * invocation keeps its trace and its reply. Absent, /steer falls back to
   * interrupt + redeliver. False = control lost.
   */
  steer?(text: string): Promise<boolean> | boolean
  runCommand(
    name: string,
    args: string,
    context: SessionControlInvocationContext
  ): Promise<{
    ok: boolean
    /** Ack markdown to post. Omitted closes the command with no post at all, for one whose visible outcome lands elsewhere (`/spawn`'s thread). */
    message?: string
    afterAck?: () => unknown | Promise<unknown>
    onHandoffReset?: () => unknown | Promise<unknown>
  }>
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
   * Inspect a claimed invocation before it is routed (e.g. a relayed
   * tool-approval verdict). Runs for EVERY claim — ordinary messages,
   * session-control commands, and messages swept into a /steer — because a
   * verdict can arrive as /steer text (the busy-session composer routes replies
   * through /steer) and treating it as steering would inject it into the
   * runtime instead of answering the pending prompt. Return true when
   * consumed; the SDK then closes it silently and moves on.
   */
  interceptClaimed?(invocation: ClaimedInvocation): Promise<boolean>
  /**
   * The scratchpad link was created or resumed (also after an unarchive
   * reattach). Runs before the link is committed locally and before presence
   * is synced, so a connector can record what this process now owns. A throw
   * leaves the session unlinked for this tick (the next poll links again); it
   * does not stop the session from connecting or claiming meanwhile.
   */
  onLinked?(link: RuntimeSessionLink): Promise<void> | void
  /** Present iff the connector can drive the runtime. Gates advertising session control (fail-safe). */
  sessionControl?: SessionControlActuator
  /**
   * The linked scratchpad was archived (the server already ended the session
   * link) and stayed archived through the restore grace window. Called after
   * the SDK has gone offline and failed its in-flight turns; the connector
   * finishes the wind-down — the Claude channel pushes its branch and kills
   * its own tmux window, so this hook may never return. An unarchive within
   * the grace window reattaches the session instead and this never fires.
   */
  onArchived?: (payload: { rootStreamId: string }) => Promise<void> | void
}

export interface ShutdownOptions {
  /**
   * The host runtime died under us — stdin closed and the parent process is
   * gone: an OOM kill, a crash, a supervisor that took the pane down. A host
   * that quit and closed us on the way out does not set this.
   */
  hostGone?: boolean
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
  closedTurn?: true
}

export interface RemoteSessionStatusSnapshot {
  stopped: boolean
  linkGeneration: number
  linkState: "unlinked" | "linked" | "detached"
  rootStreamId?: string
  activeStreamId?: string
  socketConnected: boolean
  inflightCount: number
  activeTurnStreamId?: string
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

export function effectiveRuntimeManifest(
  manifest: BotRuntimeHello["manifest"] | undefined,
  actuator: SessionControlActuator | undefined
): NonNullable<BotRuntimeHello["manifest"]> {
  return {
    output: { ...(manifest?.output ?? {}) },
    input: { updates: actuator?.steer ? "live" : "restart" },
  }
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

type ObservedClaimPhase = "unstarted" | "processing" | "running" | "terminal"

interface ObservedClaim {
  invocation: ClaimedInvocation
  handle: ObservedClaimHandle
  phase: ObservedClaimPhase
  updateInProgress: boolean
  restartPending: boolean
  lifecycle: AbortController
  /** Running turn whose input incorporated this folded/swept claim. */
  runningOwnerInvocationId?: string
}

/** The turn's source moved on between preparing a post and putting it on the wire. */
class StaleInputError extends Error {}

export interface RemoteSessionOptions {
  config: RemoteSessionConfig
  client: ThreaClient
  delegate: RemoteSessionDelegate
  runtime: RuntimeDescriptor
  /** Injectable for tests. */
  transport?: BotRuntimeTransport
  /**
   * Tap for the workspace-wide `delegation:available` socket nudge (roadmap
   * 5.4) — wire it to a `DelegationRunner.notifyAvailable()`. The nudge payload
   * carries the delegation id so a runner lacking the stream grant can claim it
   * by id (and, on 404, request access, F3). Only fires on the SDK-constructed
   * transport; an injected transport owns its callbacks.
   */
  onDelegationAvailable?: (payload?: DelegationAvailableNudge) => void
  log?: (message: string) => void
  /** Override the archive→restore grace window (tests). */
  archiveGraceMs?: number
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
  private linkGeneration = 0
  private claiming = false
  /** Claim HTTP mutates server presence outside presenceTail, so teardown waits for its drain. */
  private claimDrainTask: Promise<boolean> | undefined
  private reconnectHandoff = false
  private onHandoffReset: (() => unknown | Promise<unknown>) | undefined
  private reconnectResetTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectFallbackTask: Promise<unknown> | undefined
  private stopped = false
  private readonly archive: ArchiveGraceController
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  /** Consecutive empty poll ticks while the socket is down; drives the poll backoff. */
  private emptyNoSocketPolls = 0
  private readonly inflight = new Map<string, TurnRoute>()
  private readonly completed = new Map<string, TurnRoute>()
  private readonly terminalReplies = new Map<string, { replyDigest?: string }>()
  private nextRouteOrder = 0
  /** Teardown generation fences stale routes from writes, reinsertion, and presence changes. */
  private lifecycle = 0
  private presenceTail: Promise<void> = Promise.resolve()
  private readonly observedClaims = new Map<string, ObservedClaim>()
  // Weak ownership avoids retaining every unique cancelled invocation id for
  // the lifetime of a long-running connector while still fencing references
  // held by an interceptor/fold/command that outlive map removal.
  private readonly cancelledInvocations = new WeakSet<ClaimedInvocation>()
  private claimDrainRequested = false
  private claimDrainScheduled = false
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
    this.archive = new ArchiveGraceController(
      {
        isArchived: async (rootStreamId) => Boolean(await this.client.getStreamArchivedAt(rootStreamId)),
        reattach: () => this.relinkAfterRestore(),
        onDetached: (rootStreamId) => this.detachForArchive(rootStreamId),
        onReattached: async () => {
          await this.syncPresence()
          await this.claimDrain()
        },
        onWindDown: (rootStreamId) => this.windDownForArchive(rootStreamId),
        log: this.log,
      },
      options.archiveGraceMs === undefined ? {} : { graceMs: options.archiveGraceMs }
    )
    this.bik = new BikKeystore({
      path: this.config.bikPath ?? join(homedir(), ".threa", `bik-${sanitizeId(this.runtime.kind)}.json`),
      log: this.log,
    })
    // The transport re-sends this exact object on every reconnect hello, so the
    // BIK fields assigned into it at start() (after ensure()) ride every one.
    this.hello = {
      ...this.presenceBody("available"),
      supportedCapabilities: supportedCapabilitiesFor(this.sessionControlEnabled),
    }
    this.transport =
      options.transport ??
      new BotRuntimeTransport({
        baseUrl: this.config.baseUrl,
        workspaceId: this.config.workspaceId,
        apiKey: this.config.apiKey,
        hello: this.hello,
        beforeHello: () => this.refreshHelloCapabilities(),
        callbacks: {
          onInvocationAvailable: () => void this.claimDrain(),
          ...(options.onDelegationAvailable
            ? { onDelegationAvailable: (payload: DelegationAvailableNudge) => options.onDelegationAvailable?.(payload) }
            : {}),
          onBootstrap: (bootstrap) => {
            // A reconnect is exactly when an archive push went missing, so
            // re-derive before trusting the link the bootstrap arrived on.
            void this.probeArchiveBackstop()
            if (bootstrap.availableInvocations.length > 0 || bootstrap.ownedClaims.length > 0) void this.claimDrain()
          },
          onDisconnected: () => this.handleTransportDisconnected(),
          onSessionArchived: (payload) => void this.handleSessionArchived(payload),
          onSessionRestored: (payload) => void this.handleSessionRestored(payload),
        },
        log: this.log,
      })
  }

  private get sessionControlEnabled(): boolean {
    return Boolean(this.delegate.sessionControl)
  }

  private refreshHelloCapabilities(): void {
    let status: "available" | "busy" | "offline" = "available"
    if (this.stopped || this.archive.detached || !this.link) status = "offline"
    else if (this.reconnectHandoff || this.inflight.size > 0) status = "busy"
    Object.assign(this.hello, this.presenceBody(status))
    this.hello.supportedCapabilities = supportedCapabilitiesFor(this.sessionControlEnabled)
  }

  /** The stream of the turn the runtime is executing right now, if any. */
  get activeTurnStreamId(): string | undefined {
    return this.activeTurnStream
  }

  /** The scratchpad root stream, once linked. */
  get rootStreamId(): string | undefined {
    return this.link?.rootStreamId
  }

  get statusSnapshot(): RemoteSessionStatusSnapshot {
    const linkState = this.archive.detached ? "detached" : this.link ? "linked" : "unlinked"
    return {
      stopped: this.stopped,
      linkGeneration: this.linkGeneration,
      linkState,
      rootStreamId: this.link?.rootStreamId ?? this.archive.pendingRootStreamId,
      activeStreamId: this.link?.activeStreamId,
      socketConnected: this.transport.socketConnected,
      inflightCount: this.inflight.size,
      activeTurnStreamId: this.activeTurnStream,
    }
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
    this.startPoll()
    await this.claimDrain()
  }

  /** Create (or recover) the scratchpad link. Best-effort so a transient Threa outage self-heals on the next poll tick. */
  private async ensureLink(): Promise<void> {
    // While detached the controller's reattach is the ONLY path allowed to
    // relink: a link created here would cancel a wind-down against a
    // scratchpad that is still archived server-side.
    if (this.link || this.stopped || this.archive.detached) return
    try {
      await this.createLink()
    } catch (error) {
      this.log(`could not link to Threa (will retry): ${this.summarize(error)}${this.linkErrorHint(error)}`)
    }
  }

  /** The reattach hook: a confirmed link is what cancels the grace, so failure must read as "still archived". */
  private async relinkAfterRestore(): Promise<boolean> {
    try {
      return await this.createLink()
    } catch (error) {
      this.log(`reattach link failed: ${this.summarize(error)}${this.linkErrorHint(error)}`)
      return false
    }
  }

  private async createLink(): Promise<boolean> {
    const generation = this.archive.generation
    const link = await this.createSession()
    // A pre-archive session-create can resolve AFTER the archive lands;
    // committing it would resurrect a link to a scratchpad that is archived
    // server-side and hide the detach from the next probe.
    if (this.stopped) return false
    if (this.archive.generation !== generation) {
      this.log("link response raced an archive state change — dropped; the next probe decides")
      return false
    }
    await this.delegate.onLinked?.(link)
    // The callback can take real time (it may write files); a shutdown or
    // archive that landed meanwhile must win, same as above.
    if (this.stopped) return false
    if (this.archive.generation !== generation) {
      this.log("link response raced an archive state change — dropped; the next probe decides")
      return false
    }
    this.link = link
    this.linkGeneration += 1
    this.log(`linked to scratchpad ${this.config.baseUrl}${this.link.streamUrlPath}`)
    if (!this.archive.detached) await this.syncPresence()
    return true
  }

  /** Actionable next step for the link failures a retry alone will never fix. */
  private linkErrorHint(error: unknown): string {
    if (!(error instanceof ThreaApiError)) return ""
    if (error.status === 401 || error.status === 403) {
      return " — check THREA_API_KEY (must be a bot key, threa_bk_…) and THREA_WORKSPACE_ID"
    }
    if (error.code === "SCRATCHPAD_ARCHIVED" && !this.archive.detached) {
      return " — the server does not support ifArchived replace yet; unarchive the scratchpad in Threa to link"
    }
    return ""
  }

  async shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.archive.stop()
    this.resetReconnectHandoff()
    await this.reconnectFallbackTask
    // Fast, idempotent teardown first so SIGTERM cleanup isn't held hostage by
    // slow writes when Threa is the thing that's unreachable. Dropping the socket
    // before the offline push means updatePresence falls straight to HTTP rather
    // than waiting on an ack from a connection that's already going away.
    this.transport.disconnect()
    // Fence before awaits so an in-flight completion cannot resurrect the route or presence.
    const routes = this.revokeAllRoutes()
    await this.waitForClaimDrain()
    await this.enqueueOfflinePresence(() => this.stopped)
    if (options.hostGone && routes.length > 0) {
      // Renewal stopped above, so the claims expire on the server and the
      // next runtime on this scratchpad — the revival — claims the same
      // messages again and answers them as its own turns. Failing them here
      // would close those turns for good with nobody left to read the error.
      this.log(`host gone: leaving ${routes.length} in-flight claim(s) to lapse for the revived session`)
      return
    }
    await this.failUnansweredRoutes(routes)
  }

  private revokeAllRoutes(): TurnRoute[] {
    this.lifecycle += 1
    const inflight = [...this.inflight.values()]
    for (const route of inflight) route.revoke()
    for (const route of this.completed.values()) route.revoke()
    for (const context of this.observedClaims.values()) context.handle.dispose()
    this.observedClaims.clear()
    this.inflight.clear()
    this.completed.clear()
    this.terminalReplies.clear()
    return inflight
  }

  private async failUnansweredRoutes(routes: TurnRoute[]): Promise<void> {
    await Promise.allSettled(
      routes.map((route) =>
        // Let /complete settle before /fail so an acknowledged answer cannot be overwritten.
        Promise.resolve(route.closing)
          .catch(() => undefined)
          .then(() => {
            if (route.state === "closed") return undefined
            return Promise.allSettled(
              [route.invocation, ...route.contributors].map((invocation) =>
                this.client.fail(invocation.id, {
                  instanceId: this.config.instanceId,
                  claimToken: invocation.claimToken,
                  // The shutdown message is a fixed string (never turn content), so it
                  // is safe on sealed turns too.
                  errorMessage: this.runtime.shutdownErrorMessage,
                })
              )
            )
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
      ...(this.config.localCwd ? { localCwd: this.config.localCwd } : {}),
      // Detached-pending-restore probes always wait. Cold starts replace by
      // default, but supervisors reviving a known stream can force wait so an
      // archive between their preflight and process launch cannot mint another
      // scratchpad.
      ifArchived: this.archive.detached ? "wait" : (this.config.coldStartIfArchived ?? "replace"),
      ifMissing: this.config.expectedRootStreamId ? "error" : (this.config.coldStartIfMissing ?? "create"),
      ...(this.config.defaultLabel && { labelName: this.config.defaultLabel }),
      ...(e2e ? { e2e: { ownerKeyId: e2e.ownerKeyId } } : {}),
    })
    if (this.config.expectedRootStreamId && link.rootStreamId !== this.config.expectedRootStreamId) {
      throw new Error(
        `Session link root mismatch: expected ${this.config.expectedRootStreamId}, got ${link.rootStreamId}`
      )
    }
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

  /** Returns whether at least one invocation was claimed (feeds the poll backoff reset). */
  private claimDrain(): Promise<boolean> {
    // No claims while detached-pending-restore: the scratchpad is archived, so
    // any claimable work predates the archive and would reply into a closed
    // stream. Restore re-runs the drain.
    if (this.stopped || this.claiming || this.claimDrainTask || this.archive.detached || this.reconnectHandoff) {
      return Promise.resolve(false)
    }
    this.claiming = true
    const task = this.runClaimDrain()
    this.claimDrainTask = task
    const clear = () => {
      if (this.claimDrainTask === task) this.claimDrainTask = undefined
    }
    void task.then(clear, clear)
    return task
  }

  private async runClaimDrain(): Promise<boolean> {
    let claimedAny = false
    try {
      for (let i = 0; i < MAX_CLAIMS_PER_DRAIN; i++) {
        // One normal turn at a time: once a turn is in flight we claim with
        // session-control caps ONLY (claimBody(busy)), so /stop and /steer still
        // reach us mid-turn while a normal active-scratchpad follow-up stays
        // queued. A connector holding an open intercept window (e.g. a pending
        // tool approval whose verdict arrives as an ordinary message) keeps
        // draining with full caps via `interceptHoldsClaims`. Without runtime
        // control there's nothing to claim while busy: strict one-at-a-time.
        if (this.reconnectHandoff || this.stopped || this.archive.detached) break
        const busy = this.inflight.size > 0 && !this.interceptHoldsClaims
        if (busy && !this.sessionControlEnabled) break
        const invocation = await this.claimNext(busy)
        if (!invocation) break
        claimedAny = true
        this.markClaimProcessing(invocation)
        // Intercept before command routing: a relayed verdict can ride in as
        // /steer text, and the steer path would inject it into the runtime
        // instead of answering the prompt it belongs to.
        if (await this.interceptInvocation(invocation)) continue
        if (this.isClaimCancelled(invocation)) continue
        if (isSessionControlInvocation(invocation)) {
          const isStop = parseSessionControlCommand(invocation)?.name === "stop"
          await this.handleSessionControl(invocation)
          // After a stop, don't immediately pull the next queued turn — the user
          // asked for quiet (mirrors Pi's runStopCommand).
          if (isStop) break
          continue
        }
        const deferred = await this.startFoldedTurn(invocation)
        // Session control queued behind the folded messages still runs, and
        // still runs against the turn the fold just started — a queued /stop
        // must stop it, not the turn after it.
        for (const control of deferred) {
          if (parseSessionControlCommand(control)?.name === "stop") {
            await this.handleSessionControl(control)
            return claimedAny
          }
          await this.handleSessionControl(control)
        }
      }
    } catch (error) {
      this.log(`claim failed: ${this.summarize(error)}`)
    } finally {
      this.claiming = false
      this.scheduleRequestedClaimDrain()
    }
    return claimedAny
  }

  private async waitForClaimDrain(): Promise<void> {
    await this.claimDrainTask
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
  private async claimAndHydrate(busy: boolean, responseStreamId?: string): Promise<ClaimedInvocation | null> {
    const invocation = await this.client.claim({
      ...this.claimBody(busy),
      ...(responseStreamId ? { responseStreamId } : {}),
    })
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
      const historyRefs = opened.history.flatMap((item) => item.attachmentRefs)
      return {
        ...invocation,
        sealedContext: undefined,
        promptMarkdown: opened.promptMarkdown,
        sealing: opened.sealing,
        ...(opened.promptAttachmentRefs.length > 0 || historyRefs.length > 0
          ? { sealedAttachments: { prompt: opened.promptAttachmentRefs, history: historyRefs } }
          : {}),
        ...(messages.length > 0 ? { context: { kind: "inline" as const, messages } } : {}),
      }
    } catch (error) {
      return fail(scrubSealedError(error))
    }
  }

  private async claimNext(busy: boolean, responseStreamId?: string): Promise<ClaimedInvocation | null> {
    const invocation = await this.claimAndHydrate(busy, responseStreamId)
    if (!invocation) return null
    const identity = invocation.sealing ? this.bik.current : undefined
    const handle = this.transport.observeClaim({
      invocationId: invocation.id,
      claimToken: invocation.claimToken,
      sourceRevision: invocation.sourceRevision,
      claimTtlSeconds: CLAIM_TTL_SECONDS,
      instanceId: this.config.instanceId,
      callbacks: {
        onInputUpdated: (update, signal) => this.applyInputUpdate(invocation.id, update, signal),
        onCancelled: () =>
          this.terminalizeObservedClaim(invocation.id, "Folded input was cancelled while the turn was running."),
        onClaimLost: () =>
          this.terminalizeObservedClaim(invocation.id, "Folded claim ownership was lost while the turn was running."),
      },
      ...(invocation.sealing && identity
        ? {
            sealed: {
              identity,
              streamId: invocation.rootStreamId,
              callbackToken: invocation.sealing.callbackToken,
            },
          }
        : {}),
    })
    this.observedClaims.set(invocation.id, {
      invocation,
      handle,
      phase: "unstarted",
      updateInProgress: false,
      restartPending: false,
      lifecycle: new AbortController(),
    })
    await handle.sync()
    return this.isClaimCancelled(invocation) ? null : invocation
  }

  private markClaimProcessing(invocation: ClaimedInvocation): void {
    const context = this.observedClaims.get(invocation.id)
    if (context && context.invocation === invocation && context.phase === "unstarted") context.phase = "processing"
  }

  private installInputUpdate(context: ObservedClaim, update: InvocationInputUpdate): void {
    Object.assign(context.invocation, {
      promptMarkdown: update.promptMarkdown,
      sourceRevision: update.sourceRevision,
      ...(update.delivery === "sealed"
        ? {
            sealing: update.sealing,
            sealedAttachments: {
              prompt: update.attachmentRefs,
              history: context.invocation.sealedAttachments?.history ?? [],
            },
          }
        : { sealing: undefined, sealedAttachments: undefined }),
    })
    // Never reuse output prepared under the previous source revision/key.
    this.inflight.get(context.invocation.id)?.discardPrepared()
  }

  private abortForInputRestart(context: ObservedClaim): void {
    context.restartPending = true
    context.updateInProgress = false
    this.cancelledInvocations.add(context.invocation)
    this.abortRunningTurnForContext(context, "Folded input changed while the turn was running.")
  }

  private abortRunningTurnForContext(context: ObservedClaim, ownerFailure: string): void {
    const ownerId = context.runningOwnerInvocationId
    const running = this.inflight.get(context.invocation.id) ?? (ownerId ? this.inflight.get(ownerId) : undefined)
    if (!running) return
    try {
      this.delegate.sessionControl?.interrupt()
    } catch {
      // Backend authority still fences output when native control is gone.
    }
    running.execution.abort()
    this.clearInflight(running.invocation.id)
    if (this.activeTurnStream === running.invocation.responseStreamId) this.activeTurnStream = undefined

    const affected = [running.invocation, ...running.contributors].filter(
      (invocation) => invocation !== context.invocation
    )
    for (const invocation of affected) this.fenceObservedClaim(invocation)
    void Promise.all(affected.map((invocation) => this.failFencedInvocation(invocation, ownerFailure))).finally(() => {
      void this.syncPresence()
    })
  }

  private async applyInputUpdate(
    invocationId: string,
    update: InvocationInputUpdate,
    signal: AbortSignal
  ): Promise<"applied" | "restart-required"> {
    const context = this.observedClaims.get(invocationId)
    if (
      signal.aborted ||
      !context ||
      context.phase === "terminal" ||
      (update.delivery === "sealed" && !update.sealing)
    ) {
      return "restart-required"
    }
    if (context.phase === "unstarted") {
      this.installInputUpdate(context, update)
      return signal.aborted ? "restart-required" : "applied"
    }
    if (context.phase !== "running" || context.restartPending) {
      this.abortForInputRestart(context)
      return "restart-required"
    }

    const steer = this.delegate.sessionControl?.steer
    // reply() removes the entry before its first await. If renewal wins during
    // reply preparation, do not steer a turn that is already closing; fence its
    // pending output and let the backend perform the restart instead.
    const route = this.inflight.get(invocationId)
    if (!steer || !route || route.state !== "open" || route.revoked) {
      this.abortForInputRestart(context)
      return "restart-required"
    }

    // Renewal has already rotated the backend's accepted reply generation.
    // Install the matching revision/sealing state before any awaited attachment
    // rebuild or steering so concurrent trace/reply code can never use the old
    // cryptographic fence. Output methods pause while updateInProgress is true.
    context.updateInProgress = true
    this.installInputUpdate(context, update)
    try {
      if (signal.aborted) throw signal.reason
      const content = await this.buildTurnContent(context.invocation, { strictAttachments: true, signal })
      if (signal.aborted || this.isClaimCancelled(context.invocation)) throw signal.reason
      const interruptOnAbort = () => this.abortForInputRestart(context)
      signal.addEventListener("abort", interruptOnAbort, { once: true })
      let steered: boolean
      try {
        if (signal.aborted) throw signal.reason
        steered = await steer.call(this.delegate.sessionControl, content)
      } finally {
        signal.removeEventListener("abort", interruptOnAbort)
      }
      if (signal.aborted || this.isClaimCancelled(context.invocation) || !steered) {
        this.abortForInputRestart(context)
        return "restart-required"
      }
      context.updateInProgress = false
      route.touchIdleTimeout()
      return "applied"
    } catch {
      this.abortForInputRestart(context)
      return "restart-required"
    }
  }

  private terminalizeObservedClaim(invocationId: string, ownerFailure: string): void {
    const context = this.observedClaims.get(invocationId)
    if (!context || context.phase === "terminal") return
    this.fenceObservedClaim(context.invocation)
    this.abortRunningTurnForContext(context, ownerFailure)
    if (!this.stopped && !this.archive.detached) void this.syncPresence()
    this.claimDrainRequested = true
    this.scheduleRequestedClaimDrain()
  }

  private scheduleRequestedClaimDrain(): void {
    if (!this.claimDrainRequested || this.claimDrainScheduled || this.claiming || this.stopped || this.archive.detached)
      return
    this.claimDrainRequested = false
    this.claimDrainScheduled = true
    // A task (not an awaited/microtask re-entry) lets the currently executing
    // cancellation callback leave its global adapter queue before a replacement
    // observation calls handle.sync().
    setTimeout(() => {
      this.claimDrainScheduled = false
      if (this.stopped || this.archive.detached) return
      void this.claimDrain().finally(() => this.scheduleRequestedClaimDrain())
    }, 0)
  }

  private isClaimCancelled(invocation: ClaimedInvocation): boolean {
    return this.cancelledInvocations.has(invocation)
  }

  private isOutputCurrent(invocation: ClaimedInvocation, sourceRevision = invocation.sourceRevision): boolean {
    const context = this.observedClaims.get(invocation.id)
    return (
      !this.isClaimCancelled(invocation) &&
      invocation.sourceRevision === sourceRevision &&
      context?.phase !== "terminal" &&
      context?.restartPending !== true &&
      context?.updateInProgress !== true
    )
  }

  private releaseObservation(invocationId: string): void {
    const context = this.observedClaims.get(invocationId)
    if (!context) return
    context.phase = "terminal"
    context.handle.unregister()
    this.observedClaims.delete(invocationId)
  }

  private fenceObservedClaim(invocation: ClaimedInvocation): void {
    this.cancelledInvocations.add(invocation)
    const context = this.observedClaims.get(invocation.id)
    if (!context) return
    context.lifecycle.abort()
    context.handle.dispose()
    this.observedClaims.delete(invocation.id)
  }

  private async failFencedInvocation(invocation: ClaimedInvocation, errorMessage: string): Promise<void> {
    // A sealed turn's error text could echo decrypted content — scrub to a
    // generic reason (the /fail wire itself is shared, model A).
    const scrubbed = invocation.sealing ? "Sealed turn failed" : errorMessage.slice(0, 1000)
    await this.client
      .fail(invocation.id, {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        errorMessage: scrubbed,
      })
      .catch((error) => this.log(`invocation fail write failed: ${this.summarize(error)}`))
  }

  /** Consult the connector's intercept. True = the delegate consumed the invocation and it was closed silently. */
  private async interceptInvocation(invocation: ClaimedInvocation): Promise<boolean> {
    if (this.isClaimCancelled(invocation)) return true
    if (!this.delegate.interceptClaimed) return false
    const intercepted = await this.delegate.interceptClaimed(invocation)
    // Cancellation while the interceptor awaited consumes the claim regardless
    // of its verdict; routing it onward could execute a cancelled command/turn.
    if (this.isClaimCancelled(invocation)) return true
    if (!intercepted) return false
    try {
      await this.completeTurn(invocation, { noResponse: true })
    } catch (error) {
      await this.failAfterTerminalWrite(invocation, error, "intercepted-claim acknowledgement")
    }
    return true
  }

  /**
   * Start one turn that sees every ordinary message already queued behind this
   * one, and return any session-control commands the sweep pulled up with them.
   *
   * Without this, N messages sent while the session was busy became N
   * sequential turns, each answering a question the user had already moved
   * past — the reply to message 1 arriving after they had sent 4 more. `/steer`
   * has always folded the backlog (`sweepQueuedForSteer`); an ordinary message
   * got no such treatment, and that asymmetry is the whole of the lag.
   *
   * The primary invocation keeps the reply; the folded ones close without a
   * response of their own, exactly as the steer sweep closes what it folds.
   * Session control is never folded as text — a queued `/stop` has to stop the
   * turn, not become a line in its prompt — so it is handed back to the caller.
   */
  private async startFoldedTurn(invocation: ClaimedInvocation): Promise<ClaimedInvocation[]> {
    const parts = [await this.buildTurnContent(invocation)]
    if (this.isClaimCancelled(invocation)) return []
    const folded: ClaimedInvocation[] = []
    const control: ClaimedInvocation[] = []
    try {
      for (let i = 1; i < STEER_DRAIN_LIMIT; i++) {
        // Scoped to the primary's response stream, server-side. Folding across
        // streams would answer one stream's question in another and close the
        // rest unanswered, and a claim taken by mistake cannot be released —
        // so the filter has to keep it from being claimed at all. Sealing rides
        // along: a stream is uniformly sealed or uniformly plaintext.
        const extra = await this.claimNext(false, invocation.responseStreamId).catch(() => null)
        if (!extra) break
        this.markClaimProcessing(extra)
        if (await this.interceptInvocation(extra)) continue
        if (this.isClaimCancelled(extra)) continue
        if (isSessionControlInvocation(extra)) {
          control.push(extra)
          // Stop folding at a control command: everything after it belongs to
          // whatever that command decides.
          break
        }
        folded.push(extra)
        // formatInvocationContent, not buildTurnContent: the latter downloads
        // attachments, and nothing claimed during the sweep is renewed yet, so
        // a slow queue would expire every claim it is holding. The steer sweep
        // folds prompt text only for the same reason.
        parts.push(formatInvocationContent(extra))
      }
      // An archive can land while the sweep awaits; delivering into a detached
      // link publishes busy for a turn whose reply cannot arrive.
      if (this.stopped || this.archive.detached) {
        // Leave the folded messages claimed, exactly as the primary is left:
        // closing them here would discard their content for good, while the
        // primary comes back on the next drain. The drain's own guard says the
        // restore re-runs the pass — that has to mean all of it.
        return control
      }
      if (this.isClaimCancelled(invocation)) return control
      // A folded source can change while a later scoped claim is awaited. Its
      // callback requests a restart for that claim; omit its stale snapshot from
      // this turn and leave it for backend replacement rather than executing
      // content that is no longer canonical.
      const liveFolded = folded.filter((item) => !this.isClaimCancelled(item))
      const content = buildSteerContent([parts[0]!, ...liveFolded.map((item) => formatInvocationContent(item))])
      this.bindRunningOwner(invocation.id, liveFolded)
      await this.deliverTurn(invocation, content, liveFolded)
    } catch (error) {
      // Never throw past here. Control claimed by the sweep has to run even when
      // delivery failed — otherwise a swept /stop is claimed, never handled, and
      // interrupts an unrelated turn once its claim expires. The messages fail
      // loudly instead of vanishing into a silent close.
      const reason = `Could not start the turn: ${this.summarize(error)}`
      // The primary was registered in `inflight` before the delegate ran, so a
      // throw would otherwise leave the session reporting busy — claiming
      // session-control only — until the idle timeout fired on an invocation
      // that is already terminal.
      this.clearInflight(invocation.id)
      await this.failInvocation(invocation, reason).catch(() => undefined)
      await Promise.all(folded.map((item) => this.failInvocation(item, reason).catch(() => undefined)))
    }
    return control
  }

  private bindRunningOwner(ownerInvocationId: string, dependencies: ClaimedInvocation[]): void {
    const running = this.inflight.get(ownerInvocationId)
    for (const dependency of dependencies) {
      const context = this.observedClaims.get(dependency.id)
      if (context && context.invocation === dependency) {
        context.runningOwnerInvocationId = ownerInvocationId
        if (context.phase === "processing") context.phase = "running"
      }
      if (running && !running.contributors.some((item) => item.id === dependency.id)) {
        running.contributors.push(dependency)
      }
    }
  }

  private unbindRunningOwner(ownerInvocationId: string, dependencies: ClaimedInvocation[]): void {
    const ids = new Set(dependencies.map((item) => item.id))
    const running = this.inflight.get(ownerInvocationId)
    if (running) running.contributors = running.contributors.filter((item) => !ids.has(item.id))
    for (const dependency of dependencies) {
      const context = this.observedClaims.get(dependency.id)
      if (context?.runningOwnerInvocationId === ownerInvocationId) context.runningOwnerInvocationId = undefined
    }
  }

  private async completeContributors(route: TurnRoute): Promise<void> {
    await Promise.all(route.contributors.map((invocation) => this.completeNoResponse(invocation)))
  }

  private async failContributors(route: TurnRoute, reason: string): Promise<void> {
    await Promise.all(route.contributors.map((invocation) => this.failInvocation(invocation, reason)))
  }

  /** Register an invocation as the in-flight turn and push its content to the runtime. */
  private async deliverTurn(
    invocation: ClaimedInvocation,
    content: string,
    inputDependencies: ClaimedInvocation[] = []
  ): Promise<void> {
    if (this.isClaimCancelled(invocation)) throw new Error("invocation request is closed")
    this.registerTurn(invocation, inputDependencies)
    // This is the turn the runtime is now executing; a permission prompt it
    // triggers belongs in this invocation's stream.
    this.activeTurnStream = invocation.responseStreamId
    await this.syncPresence()
    await this.recordForwardedStep(invocation).catch(() => undefined)
    // `syncPresence` yields, and an archive landing in that window fails this
    // invocation and clears it from `inflight`. Handing it to the runtime
    // anyway would execute a turn whose reply the server has already closed.
    if (
      this.stopped ||
      this.archive.detached ||
      !this.inflight.has(invocation.id) ||
      this.isClaimCancelled(invocation) ||
      inputDependencies.some((item) => this.isClaimCancelled(item))
    ) {
      throw new Error("session went offline or its input changed before the turn could be delivered")
    }
    await this.delegate.deliverTurn({
      invocationId: invocation.id,
      streamId: invocation.responseStreamId,
      sourceMessageId: invocation.sourceMessageId,
      content,
      sealed: invocation.sealing !== undefined,
    })
    const dependencyChanged = inputDependencies.some((item) => this.isClaimCancelled(item))
    if (!this.inflight.has(invocation.id) || this.isClaimCancelled(invocation) || dependencyChanged) {
      if (dependencyChanged) {
        try {
          this.delegate.sessionControl?.interrupt()
        } catch {}
      }
      throw new Error("invocation input changed while the runtime was accepting the turn")
    }
    const observed = this.observedClaims.get(invocation.id)
    if (observed && observed.phase === "processing") observed.phase = "running"
  }

  /** The turn-handed-to-runtime trace note — sealed under the stream key on an E2E turn. */
  private async recordForwardedStep(invocation: ClaimedInvocation): Promise<void> {
    const sourceRevision = invocation.sourceRevision
    if (invocation.sealing) {
      const sealing = invocation.sealing
      const frame = await sealStep(sealing, "thinking", this.runtime.forwardedNote)
      if (!this.isOutputCurrent(invocation, sourceRevision)) return
      await this.transport.recordSealedSteps(invocation.id, sealing.callbackToken, [frame])
      return
    }
    if (!this.isOutputCurrent(invocation, sourceRevision)) return
    await this.transport.recordSteps(
      invocation.id,
      invocation.claimToken,
      [{ stepType: "thinking", content: this.runtime.forwardedNote }],
      this.runtime.busyStatusText
    )
  }

  /**
   * Close a control invocation with session-authored text or no response. Final
   * replies and idle timeouts use the prepared-close path so ambiguous retries
   * retain their exact wire body.
   */
  private async completeTurn(
    invocation: ClaimedInvocation,
    body: { markdown?: string; noResponse?: true; metadata?: Record<string, unknown>; signal?: AbortSignal }
  ): Promise<void> {
    const signal = body.signal ?? this.observedClaims.get(invocation.id)?.lifecycle.signal
    if (signal?.aborted || this.isClaimCancelled(invocation)) throw new Error("invocation request is closed")
    const sourceRevision = invocation.sourceRevision
    const assertCurrent = (): void => {
      if (signal?.aborted || !this.isOutputCurrent(invocation, sourceRevision)) {
        throw new Error("invocation request is closed")
      }
    }
    if (invocation.sealing) {
      const sealing = invocation.sealing
      const payload = body.markdown
        ? { sourceRevision, reply: await sealReply(sealing, body.markdown) }
        : { noResponse: true as const, sourceRevision }
      assertCurrent()
      await this.client.completeSealed(invocation.id, sealing.callbackToken, payload, signal)
      assertCurrent()
      this.releaseObservation(invocation.id)
      return
    }
    assertCurrent()
    await this.client.complete(
      invocation.id,
      {
        instanceId: this.config.instanceId,
        claimToken: invocation.claimToken,
        sourceRevision,
        ...(body.markdown ? { finalMessageMarkdown: body.markdown } : { noResponse: true }),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
      signal
    )
    assertCurrent()
    this.releaseObservation(invocation.id)
  }

  // --- Session control (steer / stop / delegated commands) -------------------

  private async handleSessionControl(invocation: ClaimedInvocation): Promise<void> {
    if (this.isClaimCancelled(invocation)) return
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
      if (this.isClaimCancelled(invocation)) return
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
          const outcome = await actuator.runCommand(command.name, command.args, {
            rootStreamId: invocation.rootStreamId,
            sourceMessageId: invocation.sourceMessageId,
          })
          if (this.isClaimCancelled(invocation)) return
          const ack = (): Promise<boolean> =>
            outcome.message === undefined
              ? this.completeSilentAck(invocation)
              : this.completeAck(invocation, outcome.message)
          if (!outcome.afterAck) {
            await ack()
            return
          }
          this.reconnectHandoff = true
          this.onHandoffReset = outcome.onHandoffReset
          await this.syncPresence()
          const completed = await ack()
          if (!completed || this.stopped || !this.link || this.archive.detached) {
            this.resetReconnectHandoff()
            return
          }
          try {
            await outcome.afterAck()
            this.reconnectResetTimer = setTimeout(() => this.resetReconnectHandoff(), RECONNECT_HANDOFF_FALLBACK_MS)
          } catch (error) {
            this.log(`session-control post-ack action failed: ${this.summarize(error)}`)
            this.resetReconnectHandoff()
          }
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
   * Route /steer. With a turn in flight and a steer-capable actuator, fold the
   * text into the RUNNING turn (the running invocation keeps its trace and its
   * reply). Otherwise fall back to interrupt + redeliver — the only option for
   * an idle session (there is no turn to fold into) or a runtime without
   * native mid-turn steering.
   */
  private async runSteer(invocation: ClaimedInvocation, actuator: SessionControlActuator, text: string): Promise<void> {
    const steer = actuator.steer?.bind(actuator)
    if (this.inflight.size > 0 && steer) {
      return await this.steerRunningTurn(invocation, steer, text)
    }
    return await this.steerByInterrupt(invocation, actuator, text)
  }

  /**
   * Steer in place: sweep any messages queued while busy, record a `steer`
   * step on the running turn's trace (the visible record of what was folded
   * in), and inject the combined text via the runtime's native mid-turn
   * steering. The running invocation stays the primary — its eventual reply
   * answers the steer — so the /steer command itself closes immediately
   * (command_completed resolves the card) instead of spinning until the turn
   * ends.
   */
  private async steerRunningTurn(
    invocation: ClaimedInvocation,
    steer: (text: string) => Promise<boolean> | boolean,
    text: string
  ): Promise<void> {
    const { parts, swept, interceptedCount } = await this.sweepQueuedForSteer(text)
    if (this.isClaimCancelled(invocation)) return
    if (parts.length === 0) {
      // The sweep can still have claimed foldless invocations (a queued control
      // command in the double-command race) — close them or they hang to TTL.
      await Promise.all(swept.map((item) => this.completeNoResponse(item)))
      if (invocation.metadata?.steeredMessage === true) {
        // An embedded-steer pair carries its text on the normal message. If
        // that companion is already running (or an interceptor consumed it),
        // the empty control half is only a barrier — do not post a false
        // "nothing to steer" acknowledgement.
        await this.completeTurn(invocation, {
          noResponse: true,
          metadata: {
            "remote.invocationId": invocation.id,
            "remote.sessionControl": "true",
            "remote.steered": "true",
          },
        })
        return
      }
      // A sweep that only consumed intercepted replies did real work (a verdict
      // reached its pending prompt) — "nothing to steer with" would misread as
      // the reply having been lost.
      await this.completeAck(
        invocation,
        interceptedCount > 0
          ? "Routed your reply to the session's pending request; the turn continues."
          : "Nothing to steer with (no text, no queued messages); the turn continues."
      )
      return
    }
    let combined = buildSteerContent(parts)
    // Step before actuation so it sits ahead of the continuation's frames in
    // the trace; a steer is also a sign of life for the turn it redirects.
    for (const route of [...this.inflight.values()]) {
      await this.recordSteps(route.invocation.id, [{ stepType: "steer", content: combined }])
      route.touchIdleTimeout()
    }
    if (this.isClaimCancelled(invocation)) return
    const liveSwept = swept.filter((item) => !this.isClaimCancelled(item))
    const currentParts = this.steerParts(liveSwept, text)
    if (currentParts.length === 0) {
      await Promise.all(liveSwept.map((item) => this.completeNoResponse(item)))
      await this.completeAck(invocation, "Nothing to steer with; the turn continues.")
      return
    }
    combined = buildSteerContent(currentParts)
    const owner = [...this.inflight.values()].find(
      (entry) => entry.invocation.responseStreamId === invocation.responseStreamId
    )?.invocation
    if (owner) this.bindRunningOwner(owner.id, [invocation, ...liveSwept])
    if (!(await steer(combined))) {
      // Nothing was injected: the swept messages were claimed but not
      // delivered — fail them loudly so they don't vanish into a silent close.
      if (owner) this.unbindRunningOwner(owner.id, [invocation, ...liveSwept])
      await Promise.all(
        liveSwept.map((item) => this.failInvocation(item, "Steer not delivered (runtime control unavailable); resend."))
      )
      await this.completeAck(invocation, "Could not steer the session (runtime control unavailable).")
      return
    }
    if (this.isClaimCancelled(invocation) || (owner && !this.inflight.has(owner.id))) return
    if (owner) this.unbindRunningOwner(owner.id, [invocation])
    await this.completeTurn(invocation, {
      noResponse: true,
      metadata: {
        "remote.invocationId": invocation.id,
        "remote.sessionControl": "true",
        "remote.steered": "true",
      },
    }).catch((error) => this.failAfterTerminalWrite(invocation, error, "steer completion"))
  }

  /**
   * Interrupt the running turn, then fold the steer text + any messages queued
   * while the runtime was busy into ONE combined turn (mirrors Pi: N messages →
   * 1 response). The interrupt is the only actuation; the combined content
   * round-trips through the normal delivery path so the runtime replies to it.
   */
  private async steerByInterrupt(
    invocation: ClaimedInvocation,
    actuator: SessionControlActuator,
    text: string
  ): Promise<void> {
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
    if (this.isClaimCancelled(invocation)) return
    // Always leave a visible marker carrying the steer text: a bare
    // "Superseded by /steer." followed by working silence reads as "the steer
    // was lost". The note doubles as the delivery acknowledgement.
    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text
    await this.completeInterruptedTurns(
      preview ? `Superseded by /steer — now handling: “${preview}”` : "Superseded by /steer.",
      { alwaysNote: true }
    )

    const { parts, swept, interceptedCount } = await this.sweepQueuedForSteer(text)
    if (this.isClaimCancelled(invocation)) return

    if (parts.length === 0) {
      await this.completeAck(
        invocation,
        interceptedCount > 0
          ? "Interrupted the session; your reply was routed to its pending request."
          : "Interrupted the session; nothing pending to steer with."
      )
      await this.syncPresence()
      return
    }

    this.bindRunningOwner(invocation.id, swept)
    await this.deliverTurn(invocation, buildSteerContent(parts), swept)
  }

  /**
   * Claim messages queued while the runtime was busy and fold their text in
   * (steer text last).
   *
   * Scoped to the stream the steered turn answers into, for the same reason the
   * fold's sweep is: a message belonging to another stream would be folded
   * here, closed unanswered where it was asked, and answered somewhere else.
   * Unscoped when nothing is in flight — there is no turn whose stream to
   * inherit, and the steer itself is then the only thing being folded into.
   */
  private async sweepQueuedForSteer(
    text: string
  ): Promise<{ parts: string[]; swept: ClaimedInvocation[]; interceptedCount: number }> {
    const swept: ClaimedInvocation[] = []
    let interceptedCount = 0
    const running = [...this.inflight.values()][0]?.invocation.responseStreamId
    for (let i = 0; i < STEER_DRAIN_LIMIT; i++) {
      const extra = await this.claimNext(false, running).catch(() => null)
      if (!extra) break
      this.markClaimProcessing(extra)
      // A swept message the connector intercepts (e.g. a permission verdict) is
      // consumed and closed here, never folded into the steer text — and never
      // failed by the caller's could-not-steer path, since it was delivered.
      if (await this.interceptInvocation(extra)) {
        interceptedCount++
        continue
      }
      if (this.isClaimCancelled(extra)) continue
      // The canonical text is derived after the sweep so a claim cancelled by an
      // update while a later claim awaited is omitted rather than injected stale.
      swept.push(extra)
    }
    const liveSwept = swept.filter((item) => !this.isClaimCancelled(item))
    return { parts: this.steerParts(liveSwept, text), swept: liveSwept, interceptedCount }
  }

  private steerParts(liveSwept: ClaimedInvocation[], text: string): string[] {
    const parts = liveSwept.map((item) => {
      if (!isSessionControlInvocation(item)) return item.promptMarkdown.trim() || "(empty message)"
      const queued = parseSessionControlCommand(item)
      return queued?.name === "steer" ? queued.args : ""
    })
    if (text) parts.push(text)
    return parts.filter(Boolean)
  }

  /**
   * Seal a session-control command ack under the stream key, when the claim
   * carried the SSK wraps (an E2E scratchpad). Returns undefined on a plaintext
   * claim or a key race — the caller then takes the plaintext path, which
   * closes silently on E2E rather than showing the command as failed.
   */
  private async sealSessionControlAck(
    invocation: ClaimedInvocation,
    markdown: string
  ): Promise<SealedReplyBody | undefined> {
    const ack = parseSealedAckContext(invocation.sealedAck)
    if (!ack) return undefined
    const identity = await this.bik.ensure()
    if (!identity) return undefined
    try {
      const sealing = await openSealedAck({ ack, identity, streamId: invocation.rootStreamId })
      return await sealReply(sealing, markdown)
    } catch {
      return undefined
    }
  }

  private async completeAck(invocation: ClaimedInvocation, markdown: string): Promise<boolean> {
    if (this.isClaimCancelled(invocation)) return false
    const signal = this.observedClaims.get(invocation.id)?.lifecycle.signal
    // Sealed session-control ack on E2E: seal the confirmation under the stream
    // key and post it as `sealedReply`. Falls through to the plaintext path when
    // the bot can't seal (no wrap / key race), which silently closes on E2E.
    const sealedReply = await this.sealSessionControlAck(invocation, markdown)
    if (signal?.aborted || this.isClaimCancelled(invocation)) return false
    try {
      await this.client.complete(
        invocation.id,
        {
          instanceId: this.config.instanceId,
          claimToken: invocation.claimToken,
          sourceRevision: invocation.sourceRevision,
          ...(sealedReply ? { sealedReply } : { finalMessageMarkdown: markdown }),
          metadata: {
            "remote.invocationId": invocation.id,
            "remote.sessionControl": "true",
          },
        },
        signal
      )
      if (signal?.aborted || this.isClaimCancelled(invocation)) return false
    } catch (error) {
      // Reached only when the ack couldn't be sealed (no BIK / wrap race, so
      // `sealSessionControlAck` returned undefined). On an E2E scratchpad the
      // plaintext ack is rejected with E2E_STREAM_PLAINTEXT_UNSUPPORTED; close
      // silently — the command still ran and command:completed carries the
      // feedback. Narrow to that exact code so a capability/validation 400 isn't
      // masked as a successful close (INV-11, fail loud).
      if (!sealedReply && error instanceof ThreaApiError && error.code === "E2E_STREAM_PLAINTEXT_UNSUPPORTED") {
        try {
          await this.completeTurn(invocation, { noResponse: true })
          return false
        } catch (inner) {
          await this.failAfterTerminalWrite(invocation, inner, "session-control silent acknowledgement")
          return false
        }
      }
      await this.failAfterTerminalWrite(
        invocation,
        error,
        sealedReply ? "sealed session-control acknowledgement" : "session-control acknowledgement"
      )
      return false
    }
    this.releaseObservation(invocation.id)
    return true
  }

  private async completeSilentAck(invocation: ClaimedInvocation): Promise<boolean> {
    if (this.isClaimCancelled(invocation)) return false
    try {
      await this.completeTurn(invocation, {
        noResponse: true,
        metadata: { "remote.invocationId": invocation.id, "remote.sessionControl": "true" },
      })
    } catch (error) {
      await this.failAfterTerminalWrite(invocation, error, "silent session-control acknowledgement")
      return false
    }
    return true
  }

  private async completeNoResponse(invocation: ClaimedInvocation): Promise<void> {
    try {
      await this.completeTurn(invocation, {
        noResponse: true,
        metadata: {
          "remote.invocationId": invocation.id,
          "remote.steered": "true",
        },
      })
    } catch (error) {
      await this.failAfterTerminalWrite(invocation, error, "no-response completion")
    }
  }

  private async failAfterTerminalWrite(
    invocation: ClaimedInvocation,
    error: unknown,
    operation: string
  ): Promise<void> {
    this.log(`${operation} failed: ${this.summarize(error)}`)
    if (this.isClaimCancelled(invocation)) return
    if (error instanceof ThreaApiError && error.status === 409 && error.code === "INVOCATION_INPUT_STALE") {
      this.releaseObservation(invocation.id)
      return
    }
    await this.failInvocation(invocation, `Could not persist ${operation}.`)
  }

  private async failInvocation(invocation: ClaimedInvocation, errorMessage: string): Promise<void> {
    if (this.isClaimCancelled(invocation)) return
    await this.failFencedInvocation(invocation, errorMessage)
    this.releaseObservation(invocation.id)
  }

  /**
   * Close every in-flight turn that an interrupt just aborted, so none
   * idle-hangs for an hour. By default a turn that already posted interim
   * messages closes silently (the user has heard from it); `alwaysNote` posts
   * the note regardless — steers use it so delivery is always visible.
   */
  private async completeInterruptedTurns(note: string, opts: { alwaysNote?: boolean } = {}): Promise<void> {
    const routes = [...this.inflight.values()]
    const closes = routes.map((route) => {
      route.revoke()
      if (route.state === "open") route.beginClosing()
      if (this.activeTurnStream === route.invocation.responseStreamId) this.activeTurnStream = undefined
      const generation = route.generation
      const task = route.enqueue(async () => {
        if (this.stopped || generation !== this.lifecycle || route.state === "closed") return
        const silent = route.sentCount > 0 && !opts.alwaysNote
        try {
          await this.completeTurn(route.invocation, {
            ...(silent ? { noResponse: true as const } : { markdown: `_${note}_` }),
            metadata: { "remote.invocationId": route.invocation.id, "remote.interrupted": "true" },
            signal: route.execution.signal,
          })
          route.markClosed()
          await this.completeContributors(route)
        } catch (error) {
          await this.failAfterTerminalWrite(route.invocation, error, "interrupted-turn completion")
          await this.failContributors(route, "The owning turn could not be closed after interruption.")
        } finally {
          if (generation === this.lifecycle && this.inflight.get(route.invocation.id) === route) {
            this.inflight.delete(route.invocation.id)
          }
        }
      })
      return route.trackClosing(task)
    })
    await Promise.all(closes)
  }

  /** The prompt + history the runtime reads, with any downloaded attachments appended as a manifest. */
  private async buildTurnContent(
    invocation: ClaimedInvocation,
    options: { strictAttachments?: boolean; signal?: AbortSignal } = {}
  ): Promise<string> {
    if (options.signal?.aborted) throw options.signal.reason
    const base = formatInvocationContent(invocation)
    // A sealed turn's attachments come from the refs hydration opened out of the
    // sealed payloads — the plaintext message list only holds ciphertext
    // placeholders, so there is nothing to scan there. The S3 object is opaque
    // ciphertext; the ref's key decrypts it locally.
    if (invocation.sealing) {
      const refs = invocation.sealedAttachments
      if (!refs) return base
      try {
        const downloaded = await downloadSealedInboundAttachments(this.client, {
          refs: selectSealedInboundRefs(refs.prompt, refs.history),
          invocationId: invocation.id,
          cwd: process.cwd(),
          log: this.log,
          strict: options.strictAttachments,
          signal: options.signal,
        })
        if (options.signal?.aborted) throw options.signal.reason
        const manifest = formatInboundAttachmentManifest(downloaded)
        return manifest ? `${base}\n\n${manifest}` : base
      } catch (error) {
        if (options.strictAttachments || options.signal?.aborted) throw error
        this.log(`sealed inbound attachment fetch failed: ${this.summarize(error)}`)
        return base
      }
    }
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
        strict: options.strictAttachments,
        signal: options.signal,
      })
      if (options.signal?.aborted) throw options.signal.reason
      const manifest = formatInboundAttachmentManifest(downloaded)
      return manifest ? `${base}\n\n${manifest}` : base
    } catch (error) {
      if (options.strictAttachments || options.signal?.aborted) throw error
      this.log(`inbound attachment scan failed: ${this.summarize(error)}`)
      return base
    }
  }

  // --- Interim + final output ------------------------------------------------

  private route(invocationId: string): TurnRoute | undefined {
    return this.inflight.get(invocationId) ?? this.completed.get(invocationId)
  }

  private registerTurn(invocation: ClaimedInvocation, contributors: ClaimedInvocation[] = []): TurnRoute {
    const route = new TurnRoute({
      invocation,
      contributors,
      order: (this.nextRouteOrder += 1),
      generation: this.lifecycle,
      idleTimeoutMs: this.config.idleTimeoutMs,
      onIdleDeadline: (target, generation) => void this.onReplyTimeout(target, generation),
    })
    route.armIdleTimeout()
    this.inflight.set(invocation.id, route)
    return route
  }

  private revokedResult(route: TurnRoute): SendResult {
    return {
      ok: false,
      retryable: false,
      message: `Request ${route.invocation.id} is no longer routable — this session stopped speaking for its stream.`,
    }
  }

  private async postTurnMessage(
    route: TurnRoute,
    intent: PostIntent,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const seq = route.claimSeq(intent.retry)
    const sealing = route.invocation.sealing
    const sourceRevision = route.invocation.sourceRevision
    let prepared = intent.retry
    if (!prepared) {
      if (sealing) {
        const uploaded = await uploadSealedReplyAttachments(this.client, intent.text, process.cwd())
        const fallback = uploaded.refs.length > 0 ? "" : "(empty message)"
        const body = await sealReply(
          sealing,
          uploaded.markdown.trim() || fallback,
          uploaded.refs.length > 0 ? { attachmentRefs: uploaded.refs } : undefined
        )
        prepared = {
          kind: "sealed",
          seq,
          text: intent.text,
          ...(intent.retryKey === undefined ? {} : { retryKey: intent.retryKey }),
          body,
          attachmentIds: uploaded.attachmentIds,
        }
      } else {
        const { markdown } = await uploadReplyAttachments(this.client, intent.text, process.cwd())
        prepared = {
          kind: "plaintext",
          seq,
          text: intent.text,
          ...(intent.retryKey === undefined ? {} : { retryKey: intent.retryKey }),
          body: {
            instanceId: this.config.instanceId,
            claimToken: route.invocation.claimToken,
            content: markdown,
            clientMessageId: intent.retryKey ?? `remote-send-${route.invocation.id}-${seq}`,
            metadata,
          },
        }
      }
    }
    if (!prepared) throw new Error("post preparation produced no body")
    if (route.isFenced(this.lifecycle)) {
      throw new RouteRevokedError(this.revokedResult(route).message)
    }
    if (!this.isOutputCurrent(route.invocation, sourceRevision)) {
      throw new StaleInputError("invocation input changed while the post was being prepared")
    }
    try {
      if (prepared.kind === "sealed") {
        await this.client.sendSealedMessage(route.invocation.id, sealing!.callbackToken, {
          ...prepared.body,
          ...(prepared.attachmentIds.length > 0 && { attachmentIds: prepared.attachmentIds }),
        })
      } else {
        await this.client.sendInvocationMessage(route.invocation.id, prepared.body)
      }
    } catch (error) {
      route.rememberFailedPost(seq, prepared, this.lifecycle)
      throw error
    }
    route.recordLandedPost(seq, prepared)
  }

  private async writeRouteMessage(
    route: TurnRoute,
    intent: PostIntent,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.postTurnMessage(route, intent, metadata)
    } catch (error) {
      await this.terminalizeRouteWrite(route, error)
      throw error
    }
  }

  private async prepareReply(route: TurnRoute, text: string): Promise<PreparedClose> {
    const sealing = route.invocation.sealing
    const sourceRevision = route.invocation.sourceRevision
    if (sealing) {
      const { markdown, refs, attachmentIds } = await uploadSealedReplyAttachments(this.client, text, process.cwd())
      const reply = await sealReply(
        sealing,
        markdown.trim() || "Done.",
        refs.length > 0 ? { attachmentRefs: refs } : undefined
      )
      return {
        reason: "reply",
        sourceText: text,
        wire: {
          kind: "sealed",
          callbackToken: sealing.callbackToken,
          body: { sourceRevision, reply: { ...reply, ...(attachmentIds.length > 0 && { attachmentIds }) } },
        },
      }
    }
    const { markdown, uploaded } = await uploadReplyAttachments(this.client, text, process.cwd())
    const attachmentIds = uploaded.map((attachment) => attachment.id)
    return {
      reason: "reply",
      sourceText: text,
      wire: {
        kind: "plaintext",
        body: {
          instanceId: this.config.instanceId,
          claimToken: route.invocation.claimToken,
          sourceRevision,
          finalMessageMarkdown: markdown,
          metadata: {
            "remote.invocationId": route.invocation.id,
            "remote.instanceId": this.config.instanceId,
            ...(attachmentIds.length > 0 && { "remote.attachmentIds": attachmentIds.join(",") }),
          },
        },
      },
    }
  }

  private async prepareTimeout(route: TurnRoute): Promise<PreparedClose> {
    const note = "_The session ended the turn without sending a reply._"
    const noResponse = route.sentCount > 0
    const sealing = route.invocation.sealing
    const sourceRevision = route.invocation.sourceRevision
    if (sealing) {
      return {
        reason: "timeout",
        wire: {
          kind: "sealed",
          callbackToken: sealing.callbackToken,
          body: noResponse
            ? { noResponse: true, sourceRevision }
            : { sourceRevision, reply: await sealReply(sealing, note) },
        },
      }
    }
    return {
      reason: "timeout",
      wire: {
        kind: "plaintext",
        body: {
          instanceId: this.config.instanceId,
          claimToken: route.invocation.claimToken,
          sourceRevision,
          ...(noResponse ? { noResponse: true as const } : { finalMessageMarkdown: note }),
          metadata: { "remote.invocationId": route.invocation.id, "remote.timedOut": "true" },
        },
      },
    }
  }

  private async postPreparedClose(route: TurnRoute, prepared: PreparedClose): Promise<void> {
    if (route.isFenced(this.lifecycle)) throw new RouteRevokedError("route revoked")
    if (prepared.wire.kind === "sealed") {
      await this.client.completeSealed(
        route.invocation.id,
        prepared.wire.callbackToken,
        prepared.wire.body,
        route.execution.signal
      )
      return
    }
    await this.client.complete(route.invocation.id, prepared.wire.body, route.execution.signal)
  }

  private async settleClosed(route: TurnRoute, replyText?: string): Promise<void> {
    const invocationId = route.invocation.id
    route.settleClosed(replyText)
    this.inflight.delete(invocationId)
    // Teardown owns reinsertion and presence if it advanced the route generation.
    if (route.isFenced(this.lifecycle)) return
    // Keep the same object so ids reserved by posts queued behind this close remain visible.
    this.completed.delete(invocationId)
    this.completed.set(invocationId, route)
    for (const oldest of this.completed.keys()) {
      if (this.completed.size <= COMPLETED_TURN_MEMORY) break
      this.completed.delete(oldest)
    }
    if (this.activeTurnStream === route.invocation.responseStreamId) this.activeTurnStream = undefined
    await this.syncPresence()
  }

  private async reopenAfterFailedCompletion(route: TurnRoute, prepared: PreparedClose | undefined): Promise<void> {
    if (route.isFenced(this.lifecycle)) {
      route.reopen(undefined)
      return
    }
    route.reopen(prepared)
    route.armIdleTimeout()
    this.inflight.set(route.invocation.id, route)
    await this.syncPresence()
  }

  private touchCompleted(invocationId: string, record: TurnRoute): void {
    if (!this.completed.delete(invocationId)) return
    this.completed.set(invocationId, record)
  }

  private isTerminalPostError(error: unknown): boolean {
    return (
      error instanceof ThreaApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      !RETRYABLE_POST_STATUSES.has(error.status)
    )
  }

  private async terminalizeRouteWrite(route: TurnRoute, error: unknown): Promise<boolean> {
    if (!this.isTerminalPostError(error)) return false
    if (!route.terminal) await this.evictTerminalRoute(route)
    return true
  }

  private terminalWriteResult(invocationId: string, kind: "message" | "reply", error: unknown): SendResult {
    return {
      ok: false,
      retryable: false,
      message: `Threa rejected the ${kind} for request ${invocationId}: ${this.summarize(error)}.`,
    }
  }

  private terminalResult(invocationId: string, kind: "send" | "reply", text: string): SendResult {
    const tombstone = this.terminalReplies.get(invocationId)
    if (kind === "reply" && tombstone?.replyDigest === this.replyDigest(text)) return { ok: true, message: "sent" }
    return {
      ok: false,
      retryable: false,
      message: `Threa refused further messages for request ${invocationId} — it is closed and no longer accepts follow-ups.`,
    }
  }

  /** Drop write credentials but retain a digest for exact final-reply idempotency. */
  private async evictTerminalRoute(route: TurnRoute): Promise<void> {
    const invocationId = route.invocation.id
    route.markTerminal()
    this.releaseObservation(invocationId)
    this.inflight.delete(invocationId)
    this.completed.delete(invocationId)
    const newerRouteOwnsStream = [...this.inflight.values()].some(
      (candidate) =>
        candidate.order > route.order &&
        !candidate.revoked &&
        candidate.invocation.responseStreamId === route.invocation.responseStreamId
    )
    if (this.activeTurnStream === route.invocation.responseStreamId && !newerRouteOwnsStream) {
      this.activeTurnStream = undefined
    }
    this.terminalReplies.delete(invocationId)
    this.terminalReplies.set(invocationId, {
      ...(route.replyText === undefined ? {} : { replyDigest: this.replyDigest(route.replyText) }),
    })
    for (const oldest of this.terminalReplies.keys()) {
      if (this.terminalReplies.size <= COMPLETED_TURN_MEMORY) break
      this.terminalReplies.delete(oldest)
    }
    await this.syncPresence()
  }

  private async postThroughClosed(route: TurnRoute, kind: "send" | "reply", intent: PostIntent): Promise<SendResult> {
    const invocationId = route.invocation.id
    if (kind === "reply" && route.replyText === intent.text) {
      this.touchCompleted(invocationId, route)
      return { ok: true, message: "sent" }
    }
    if (route.terminal) return this.terminalResult(invocationId, kind, intent.text)
    try {
      await this.writeRouteMessage(route, intent, {
        "remote.invocationId": invocationId,
        "remote.followUp": "true",
      })
    } catch (error) {
      if (error instanceof RouteRevokedError) return this.revokedResult(route)
      if (this.isTerminalPostError(error)) return this.terminalWriteResult(invocationId, "message", error)
      return { ok: false, message: `Failed to post message to Threa: ${this.summarize(error)}`, retryable: true }
    }
    if (kind === "reply") route.replyText = intent.text
    this.touchCompleted(invocationId, route)
    return {
      ok: true,
      message: `Posted as a follow-up message — request ${invocationId} had already closed, and stays closed.`,
    }
  }

  async sendInterim(invocationId: string, text: string): Promise<SendResult> {
    const route = this.route(invocationId)
    if (!route) {
      if (this.terminalReplies.has(invocationId)) return this.terminalResult(invocationId, "send", text)
      return {
        ok: false,
        retryable: false,
        message: `No open request with invocation_id ${invocationId} — interim messages need an open request (it may have been answered or closed).`,
      }
    }
    const intent = route.snapshotIntent(text)
    return route.enqueue(() => this.runSend(route, intent))
  }

  private async runSend(route: TurnRoute, intent: PostIntent): Promise<SendResult> {
    if (route.terminal) return this.terminalResult(route.invocation.id, "send", intent.text)
    if (route.revoked) return this.revokedResult(route)
    if (route.state === "closed") return this.postThroughClosed(route, "send", intent)
    if (this.observedClaims.get(route.invocation.id)?.updateInProgress) {
      return { ok: false, message: "Input update is still in progress; retry this send.", retryable: true }
    }
    const sourceRevision = route.invocation.sourceRevision
    try {
      await this.writeRouteMessage(route, intent, {
        "remote.invocationId": route.invocation.id,
        "remote.interim": "true",
      })
    } catch (error) {
      if (error instanceof RouteRevokedError) return this.revokedResult(route)
      if (error instanceof StaleInputError) {
        return {
          ok: false,
          message: "Input changed while preparing this send; retry on the current turn.",
          retryable: true,
        }
      }
      if (this.isTerminalPostError(error)) return this.terminalWriteResult(route.invocation.id, "message", error)
      return { ok: false, message: `Failed to post message to Threa: ${this.summarize(error)}`, retryable: true }
    }
    if (!this.isOutputCurrent(route.invocation, sourceRevision)) {
      return {
        ok: false,
        message: `Message post raced a source update for ${route.invocation.id}; do not treat it as current-turn output.`,
      }
    }
    // A send is a sign of life: push the idle timeout out so a turn that keeps
    // posting progress is never force-closed.
    route.touchIdleTimeout()
    return { ok: true, message: "sent" }
  }

  async reply(invocationId: string, text: string): Promise<SendResult> {
    const route = this.route(invocationId)
    if (!route) {
      if (this.terminalReplies.has(invocationId)) return this.terminalResult(invocationId, "reply", text)
      return {
        ok: false,
        retryable: false,
        message: `No open request with invocation_id ${invocationId} (already answered, expired, or unknown).`,
      }
    }
    const intent = route.snapshotIntent(text)
    return route.enqueue(() => this.runReply(route, intent))
  }

  private async runReply(route: TurnRoute, intent: PostIntent): Promise<SendResult> {
    if (route.state === "closed" && route.replyText === intent.text) return { ok: true, message: "sent" }
    if (route.terminal) return this.terminalResult(route.invocation.id, "reply", intent.text)
    if (route.revoked) return this.revokedResult(route)
    if (route.state === "closed") return this.postThroughClosed(route, "reply", intent)
    if (this.observedClaims.get(route.invocation.id)?.updateInProgress) {
      return { ok: false, message: "Input update is still in progress; retry this reply.", retryable: true }
    }
    // Resolve an ambiguous earlier close before posting changed text under a new id.
    if (route.prepared && (route.prepared.reason === "timeout" || route.prepared.sourceText !== intent.text)) {
      const resolved = await this.closeWith(route, route.prepared)
      if (!resolved.ok) {
        return {
          ok: false,
          retryable: resolved.retryable ?? false,
          message: `The earlier close for request ${route.invocation.id} has not landed yet, so it still owns the close: ${resolved.message}`,
        }
      }
      const followUp = await this.postThroughClosed(route, "reply", intent)
      return resolved.closedTurn ? { ...followUp, closedTurn: true } : followUp
    }
    return this.closeWith(route, route.prepared ?? { kind: "reply", text: intent.text })
  }

  private closeWith(route: TurnRoute, source: PreparedClose | CloseRequest): Promise<SendResult> {
    route.beginClosing()
    return route.trackClosing(this.runCompletion(route, source))
  }

  private async runCompletion(route: TurnRoute, source: PreparedClose | CloseRequest): Promise<SendResult> {
    const sourceRevision = route.invocation.sourceRevision
    let prepared: PreparedClose
    if ("wire" in source) {
      prepared = source
    } else {
      try {
        prepared =
          source.kind === "reply" ? await this.prepareReply(route, source.text) : await this.prepareTimeout(route)
      } catch (error) {
        await this.reopenAfterFailedCompletion(route, undefined)
        if (route.revoked) return this.revokedResult(route)
        return {
          ok: false,
          message: `Failed to post reply to Threa (will stay open for retry): ${this.summarize(error)}`,
          retryable: true,
        }
      }
    }
    if (!this.isOutputCurrent(route.invocation, sourceRevision)) return this.closeStaleReply(route)
    route.prepared = prepared
    try {
      await this.postPreparedClose(route, prepared)
    } catch (error) {
      if (this.isClaimCancelled(route.invocation)) return this.closeStaleReply(route)
      if (error instanceof ThreaApiError && error.status === 409 && error.code === "INVOCATION_INPUT_STALE") {
        this.releaseObservation(route.invocation.id)
        await this.failContributors(route, "The owning turn input became stale during completion.")
        return this.closeStaleReply(route)
      }
      if (await this.terminalizeRouteWrite(route, error)) {
        return this.terminalWriteResult(route.invocation.id, "reply", error)
      }
      await this.reopenAfterFailedCompletion(route, prepared)
      if (error instanceof RouteRevokedError || route.revoked) return this.revokedResult(route)
      return {
        ok: false,
        message: `Failed to post reply to Threa (will stay open for retry): ${this.summarize(error)}`,
        retryable: true,
      }
    }
    this.releaseObservation(route.invocation.id)
    await this.completeContributors(route)
    await this.settleClosed(route, prepared.reason === "reply" ? prepared.sourceText : undefined)
    return { ok: true, message: "sent", closedTurn: true }
  }

  private async closeStaleReply(route: TurnRoute): Promise<SendResult> {
    route.revoke()
    if (this.inflight.get(route.invocation.id) === route) this.inflight.delete(route.invocation.id)
    if (this.activeTurnStream === route.invocation.responseStreamId) this.activeTurnStream = undefined
    await this.syncPresence()
    return { ok: false, message: `Request ${route.invocation.id} is closed; its source changed.` }
  }

  /**
   * Record trace steps against an in-flight turn. Fire-and-forget: a failed
   * frame is logged and dropped, not retried — steps are ephemeral progress,
   * not state. Returns false when the invocation is no longer taking work
   * (answered, expired, superseded, or its completion is already on the wire),
   * which a transcript tailer uses as its stop signal. Frames must arrive
   * already redacted (or full, on a sealed turn — the tailer decides); this
   * method ships them verbatim, sealing each one under the stream key when the
   * turn is sealed so plaintext step content never leaves the machine on an E2E
   * scratchpad.
   */
  async recordSteps(invocationId: string, frames: StepFrame[], statusText?: string): Promise<boolean> {
    const entry = this.openRoute(invocationId)
    if (!entry) return false
    // Keep the tracer alive but do not emit old-turn frames while the runtime is
    // being steered onto a newer authoritative input.
    if (this.observedClaims.get(invocationId)?.updateInProgress) return true
    // The server rejects >50 frames per steps call (plaintext and sealed alike),
    // so a large batch (e.g. a transcript replay after late binding) ships in chunks.
    for (let start = 0; start < frames.length; start += MAX_STEP_FRAMES_PER_CALL) {
      const chunk = frames.slice(start, start + MAX_STEP_FRAMES_PER_CALL)
      const sourceRevision = entry.invocation.sourceRevision
      if (entry.invocation.sealing) {
        // Sealed turn: seal each frame under the stream key and ship on the
        // sealed wire. No statusText — the sealed wire deliberately carries
        // none (a plaintext status derived from sealed content would leak).
        const sealing = entry.invocation.sealing
        try {
          const sealedFrames = await Promise.all(chunk.map((frame) => sealStep(sealing, frame.stepType, frame.content)))
          if (!this.isOutputCurrent(entry.invocation, sourceRevision)) return this.inflight.has(invocationId)
          await this.transport.recordSealedSteps(invocationId, sealing.callbackToken, sealedFrames)
        } catch (error) {
          this.log(`recordSteps (sealed) failed: ${this.summarize(error)}`)
        }
      } else {
        if (!this.isOutputCurrent(entry.invocation, sourceRevision)) return this.inflight.has(invocationId)
        await this.transport
          .recordSteps(invocationId, entry.invocation.claimToken, chunk, statusText ?? this.runtime.busyStatusText)
          .catch((error) => this.log(`recordSteps failed: ${this.summarize(error)}`))
      }
      // The turn can close during an awaited send (reply, /stop, idle timeout)
      // — exactly the long multi-chunk replays this loop exists for. Recheck so
      // the returned boolean stays an honest stop signal for the tailer.
      if (!this.openRoute(invocationId)) return false
    }
    return true
  }

  async postToInvocation(
    invocationId: string,
    body: { content: string; clientMessageId?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const route = this.route(invocationId)
    if (!route) throw this.routeUnavailableError(invocationId)
    await this.postRouteOwnedMessage(route, body)
  }

  async postToStream(
    streamId: string,
    body: { content: string; clientMessageId?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const route = this.routeForStream(streamId)
    if (route) {
      await this.postRouteOwnedMessage(route, body)
      return
    }
    await this.client.sendMessage(streamId, body)
  }

  private async postRouteOwnedMessage(
    route: TurnRoute,
    body: { content: string; clientMessageId?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const intent = route.snapshotIntent(body.content, body.clientMessageId)
    await route.enqueue(async () => {
      if (route.terminal) throw this.routeUnavailableError(route.invocation.id)
      if (route.revoked) throw new RouteRevokedError(this.revokedResult(route).message)
      await this.writeRouteMessage(route, intent, {
        "remote.invocationId": route.invocation.id,
        ...body.metadata,
      })
      if (route.state === "closed") this.touchCompleted(route.invocation.id, route)
    })
  }

  private routeUnavailableError(invocationId: string): Error {
    if (this.terminalReplies.has(invocationId)) {
      return new Error(`Threa refused further messages for request ${invocationId}; its route is terminal.`)
    }
    return new Error(`No routable request with invocation_id ${invocationId} exists in this session.`)
  }

  private routeForStream(streamId: string): TurnRoute | undefined {
    let closing: TurnRoute | undefined
    for (const route of this.inflight.values()) {
      if (route.invocation.responseStreamId !== streamId) continue
      if (route.state === "open") return route
      closing ??= route
    }
    return closing
  }

  private openRoute(invocationId: string): TurnRoute | undefined {
    const route = this.inflight.get(invocationId)
    return route?.state === "open" && !route.revoked ? route : undefined
  }

  /** Whether this session still holds the invocation open (not yet replied, timed out, or superseded). */
  isInflight(invocationId: string): boolean {
    return this.openRoute(invocationId) !== undefined
  }

  /** Reset idle timeouts for every in-flight turn in a stream (a pending approval is a sign of life). */
  keepAlive(streamId: string): void {
    for (const entry of this.inflight.values()) {
      if (entry.state === "open" && entry.invocation.responseStreamId === streamId) entry.touchIdleTimeout()
    }
  }

  /** Queue timeout closure behind posts so in-flight output cannot be overtaken. */
  private async onReplyTimeout(route: TurnRoute, generation: number): Promise<void> {
    if (!route.isCurrentDeadline(generation) || route.state !== "open") return
    await route.enqueue(() => this.runIdleTimeout(route, generation))
  }

  private async runIdleTimeout(route: TurnRoute, generation: number): Promise<void> {
    if (!route.isCurrentDeadline(generation) || route.state !== "open" || route.revoked) return
    const result = await this.closeWith(route, route.prepared ?? { kind: "timeout" })
    if (!result.ok) this.log(`timeout close failed: ${result.message}`)
  }

  private clearInflight(invocationId: string): void {
    const entry = this.inflight.get(invocationId)
    if (!entry) return
    entry.revoke()
    this.inflight.delete(invocationId)
  }

  /**
   * A `bot:session_archived` push. Scoped to this session AND this root: a
   * runtime that re-registered under a new session id, or a cold start that
   * replaced an archived scratchpad with a fresh one, must not die to a stale
   * event for the retired root.
   */
  private async handleSessionArchived(payload: unknown): Promise<void> {
    const data = (payload ?? {}) as { runtimeSessionId?: unknown; rootStreamId?: unknown }
    if (typeof data.runtimeSessionId === "string" && data.runtimeSessionId !== this.config.runtimeSessionId) return
    const linked = this.link?.rootStreamId
    const rootStreamId = typeof data.rootStreamId === "string" ? data.rootStreamId : linked
    if (!rootStreamId || (linked && rootStreamId !== linked)) return
    await this.archive.archived(rootStreamId)
  }

  /** A `bot:session_restored` push: the server revived this session's link. */
  private async handleSessionRestored(payload: unknown): Promise<void> {
    const data = (payload ?? {}) as { runtimeSessionId?: unknown }
    if (typeof data.runtimeSessionId === "string" && data.runtimeSessionId !== this.config.runtimeSessionId) return
    await this.archive.restored()
  }

  /**
   * `bot:session_archived` is a one-shot push with no replay: a socket that was
   * down when the archive landed never learns of it, and the runtime then holds
   * a link to a dead scratchpad forever — taking its tmux window and worktree
   * with it. Re-derive from the server on every poll tick and socket bootstrap.
   */
  private async probeArchiveBackstop(): Promise<void> {
    await this.archive.probe(this.link?.rootStreamId)
  }

  /**
   * Detach effects. No more work can arrive, so fail any in-flight turn (its
   * reply could no longer land), drop the link, and go offline — but the
   * worktree survives until the grace expires.
   */
  private async detachForArchive(rootStreamId: string): Promise<void> {
    const inflight = this.revokeAllRoutes()
    this.activeTurnStream = undefined
    this.link = undefined
    this.linkGeneration += 1
    this.resetReconnectHandoff()
    await this.reconnectFallbackTask
    // Pull the next poll tick onto the probe cadence NOW — the pending tick was
    // scheduled with the slow socket-backstop delay (15 min), which would land
    // zero probes inside the grace window if the restore push is then missed.
    this.reschedulePoll(this.archive.probeDelayMs)
    await this.waitForClaimDrain()
    const offline = this.enqueueOfflinePresence(
      () => !this.stopped && this.archive.pendingRootStreamId === rootStreamId
    )
    await this.failUnansweredRoutes(inflight)
    await offline
  }

  /** The grace expired with the scratchpad still archived: hand the connector its terminal wind-down. */
  private async windDownForArchive(rootStreamId: string): Promise<void> {
    await this.shutdown()
    await this.delegate.onArchived?.({ rootStreamId })
  }

  // --- Timers ---------------------------------------------------------------

  private startPoll(): void {
    this.reschedulePoll(this.config.pollMs)
  }

  private handleTransportDisconnected(): void {
    this.emptyNoSocketPolls = 0
    this.reschedulePoll(this.config.pollMs)
  }

  /** (Re)arm the poll timer. Replaces any pending tick so a state change can pull the next tick closer. */
  private reschedulePoll(delayMs: number): void {
    if (this.stopped) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.pollTick(), delayMs)
  }

  private async pollTick(): Promise<void> {
    if (this.stopped) return
    // Always first: while detached this is the reattach attempt (ensureLink
    // refuses to relink during the grace), and while linked it is the
    // missed-push backstop.
    await this.probeArchiveBackstop()
    if (!this.link) await this.ensureLink()
    if (!this.transport.socketConnected) await this.transport.connect()
    const claimed = await this.claimDrain()
    // shutdown() can land during the awaits above; re-arming then would leave
    // a live timer past teardown.
    if (!this.stopped) this.reschedulePoll(this.nextPollDelay(claimed))
  }

  /**
   * Socket up → slow backstop (pushes deliver work). Socket down → start at the
   * configured fast cadence and double per empty tick up to the cap, so an
   * active HTTP-only conversation stays snappy while an idle socketless session
   * can't burn the edge-request quota. Claimed work resets the backoff.
   */
  private nextPollDelay(claimed: boolean): number {
    // Detached-pending-restore: probe at a fixed cadence so a missed
    // bot:session_restored push still reattaches within the grace window. The
    // window bounds the total probes, so this cannot become a quota burn.
    if (this.archive.detached) return this.archive.probeDelayMs
    if (this.transport.socketConnected) {
      this.emptyNoSocketPolls = 0
      return WS_BACKSTOP_POLL_MS
    }
    if (claimed) {
      this.emptyNoSocketPolls = 0
      return this.config.pollMs
    }
    const delay = Math.min(NO_SOCKET_POLL_CAP_MS, this.config.pollMs * 2 ** this.emptyNoSocketPolls)
    this.emptyNoSocketPolls = Math.min(this.emptyNoSocketPolls + 1, 30)
    return delay
  }

  // --- Helpers --------------------------------------------------------------

  private resetReconnectHandoff(): void {
    if (this.reconnectResetTimer) clearTimeout(this.reconnectResetTimer)
    this.reconnectResetTimer = undefined
    const wasHandoff = this.reconnectHandoff
    this.reconnectHandoff = false
    const onHandoffReset = this.onHandoffReset
    this.onHandoffReset = undefined
    if (!wasHandoff && !onHandoffReset) return
    let callbackTask: Promise<unknown> | undefined
    if (onHandoffReset) {
      try {
        callbackTask = Promise.resolve(onHandoffReset()).catch((error) =>
          this.log(`session-control handoff reset failed: ${this.summarize(error)}`)
        )
      } catch (error) {
        this.log(`session-control handoff reset failed: ${this.summarize(error)}`)
      }
    }
    if (this.stopped || !this.link || this.archive.detached) {
      if (callbackTask) this.reconnectFallbackTask = callbackTask
      return
    }
    let task: Promise<unknown>
    const restoreIntake = () => this.syncPresence().then(() => this.claimDrain())
    task = (callbackTask ? callbackTask.then(restoreIntake) : restoreIntake()).finally(() => {
      if (this.reconnectFallbackTask === task) this.reconnectFallbackTask = undefined
    })
    this.reconnectFallbackTask = task
  }

  private enqueuePresence(write: () => Promise<void>): Promise<void> {
    const queued = this.presenceTail.then(write)
    this.presenceTail = queued.catch(() => undefined)
    return this.presenceTail
  }

  /** Derive presence when this generation's queued write runs, not when queued. */
  private syncPresence(): Promise<void> {
    const lifecycle = this.lifecycle
    return this.enqueuePresence(async () => {
      if (lifecycle !== this.lifecycle || this.stopped || this.archive.detached) return
      const busy = this.reconnectHandoff || this.inflight.size > 0
      await this.transport.updatePresence(
        this.presenceBody(busy ? "busy" : "available", busy ? this.runtime.busyStatusText : undefined)
      )
    })
  }

  private enqueueOfflinePresence(isCurrent: () => boolean): Promise<void> {
    const lifecycle = this.lifecycle
    return this.enqueuePresence(async () => {
      if (lifecycle !== this.lifecycle || !isCurrent()) return
      await this.transport.updatePresence(this.presenceBody("offline"))
    })
  }

  private presenceBody(status: "available" | "busy" | "offline", statusText?: string) {
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
      manifest: effectiveRuntimeManifest(this.runtime.manifest, this.delegate.sessionControl),
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

  private replyDigest(text: string): string {
    return createHash("sha256").update(text).digest("hex")
  }

  private summarize(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 200)
  }
}
