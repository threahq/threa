import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, hostname, platform, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import {
  attachmentLocalPath,
  BikKeystore,
  BotRuntimeTransport,
  THREA_CALLBACK_TOKEN_HEADER,
  base64ToBytes,
  bytesToBase64,
  decryptAttachmentBytes,
  encryptAttachmentBytes,
  mintStreamKeyWraps,
  openSealedAck,
  openSealedTurnContext,
  parseSealedAckContext,
  parseSealedTurnContext,
  ArchiveGraceController,
  WS_BACKSTOP_POLL_MS,
  scrubSealedError,
  sealReply,
  sealStep,
  type AttachmentRef,
  type BotIdentityKey,
  type BotRuntimeHello,
  type InvocationInputUpdate,
  type ObservedClaimHandle,
  type DecryptedHistoryItem,
  type SealedReplyBody,
  type SealingState,
} from "@threahq/bot-runtime-client"
import {
  discardSpawnBrief,
  harnessReconnectAvailable,
  parseSpawnCommandArgs,
  prepareHarnessClear,
  prepareHarnessDone,
  prepareHarnessReconnect,
  prepareHarnessSpawn,
  runHarnessKick,
  writeSpawnBrief,
  parseAllowedTmuxKey,
  sendAllowedTmuxKey,
  killOwnWindow,
  markHarnessLinkWoundDown,
  recordHarnessLink,
} from "@threa/harness-client"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

const PRODUCTION_STORAGE_DIRECTORY = join(homedir(), ".pi", "agent")
const TEST_ENTRYPOINT_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/

function isTestEntrypoint(entrypoint = process.argv[1]): boolean {
  return TEST_ENTRYPOINT_PATTERN.test(entrypoint ?? "")
}

// Bun test runs all selected files with the first test file as argv[1]. Keep
// the boundary private even when a future test forgets to install its own path.
const DEFAULT_STORAGE_DIRECTORY = isTestEntrypoint()
  ? join(tmpdir(), `threa-pi-remote-tests-${process.pid}`)
  : PRODUCTION_STORAGE_DIRECTORY
let CONFIG_PATH = join(DEFAULT_STORAGE_DIRECTORY, "threa-remote.json")
// The Bot Identity Key (BIK): a per-install X25519 keypair the harness registers
// so an owner can wrap an E2E scratchpad's stream key to it (design §2.6).
// Persisted separately from the config (private key material, mode 0600) and
// stable across restarts — the owner's wraps target its `publicKeyId`, so
// rotating it would orphan every wrap.
let BIK_PATH = join(DEFAULT_STORAGE_DIRECTORY, "threa-remote-bik.json")
// Per-session sidecar (`threa-remote-pending-<runtimeSessionId>.json`) carrying
// the in-flight claim across `/reload`: Pi clears the extension module cache on
// reload, so every top-level binding (pending, observations, captured texts)
// is wiped and only disk state crosses the boundary.
let PENDING_SNAPSHOT_DIRECTORY = DEFAULT_STORAGE_DIRECTORY
const STATUS_KEY = "threa-remote"
const NO_RESPONSE_MARKER = "THREA_NO_RESPONSE"
/** Server cap on `attachmentIds` per sealed message (`sealedAttachmentIdsSchema` caps at 16). */
const MAX_SEALED_ATTACHMENTS_PER_MESSAGE = 16
const FETCH_TIMEOUT_MS = 30_000
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_FAILURE_POLL_MS = 60_000
const BUSY_HEARTBEAT_MS = 15_000
const CLAIM_TTL_SECONDS = 120
const PI_MANIFEST = {
  output: { reply: true, trace: true, sources: false },
  input: { updates: "live" as const },
}
// With NO socket the poll is the only delivery path, but an idle session
// spinning at pollMs (3s) burns ~29k billed edge requests/day. Empty idle ticks
// back off exponentially to this cap; a claim, an active turn, or a socket
// reconnect resets to the fast cadence. Turns in flight never back off, so
// steer/stop and queued follow-ups stay responsive mid-turn; the shared
// observation client independently maintains claim authority.
const NO_SOCKET_POLL_CAP_MS = 2 * 60 * 1000
const WS_RECONNECTION_DELAY_MAX_MS = 30_000
const TRACE_CONTENT_MAX_CHARS = 9_500
const COMMAND_TRACE_MAX_CHARS = 2_000
const COMMAND_HEADLINE_MAX_CHARS = 180
// Sealed steps carry ciphertext the server never reads, so the plaintext step
// schema's 10K cap doesn't apply — a full-detail sealed trace (real command,
// patch, stdout) gets a much roomier clamp, bounded only to keep frames sane.
const SEALED_TRACE_CONTENT_MAX_CHARS = 60_000
const MAX_AUTO_RETRY_MS = 4 * 60 * 60 * 1000
const MAX_RETRY_ATTEMPTS = 3
const CONTRIBUTOR_FAIL_RETRY_DELAYS_MS = [10, 25] as const
const MAX_CONTRIBUTOR_FAIL_ATTEMPTS = 6
const CONTRIBUTOR_FAIL_RETRY_BATCH_DELAY_MS = 100
const CONTRIBUTOR_FAIL_RETRY_COOLDOWN_MS = 30_000
const PI_TOOL_TRACE_FORMAT = "pi_tool_trace"
const SESSION_CONTROL_CAPABILITY = "session-control"
const RELOAD_HANDOFF_COMMAND = "threa-remote-reload"
/** How long a queued reload handoff may sit undispatched before the latch is released. */
let reloadWatchdogMs = 15_000
const SESSION_CONTROL_COMMANDS = [
  "compact",
  "model",
  "thinking",
  "skill",
  "reload",
  "shell",
  "steer",
  "stop",
  "kick",
  "carry-on",
  "reconnect",
  "clear",
  "spawn",
  "done",
  "key",
] as const
type PiSessionControlCommandName = (typeof SESSION_CONTROL_COMMANDS)[number]
const STEER_DRAIN_LIMIT = 10
const SHELL_TIMEOUT_MS = 60_000
// 32K chars per stream — large enough for typical output, small enough to avoid
// dumping a CI log into the scratchpad if a curious user pipes `find /` in.
const SHELL_MAX_OUTPUT_CHARS = 32 * 1024
const SHELL_USAGE = [
  "Usage: `/shell <command>`",
  "Runs in the linked Pi session's working directory via `$SHELL -c`.",
  "60s timeout; output capped at 32K chars per stream.",
].join("\n")
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]
const execFileAsync = promisify(execFile)
const OPEN_URL_TIMEOUT_MS = 10_000

const PI_TOOL_TRACE_SECTION_LABELS = {
  ARGUMENTS: "Arguments",
  OUTPUT: "Output",
  ERROR_OUTPUT: "Error output",
  DETAILS: "Details",
} as const

type PiToolTraceSectionLabel = (typeof PI_TOOL_TRACE_SECTION_LABELS)[keyof typeof PI_TOOL_TRACE_SECTION_LABELS]

const BASE_TRACE_MODES = ["headline", "commands"] as const
const BASE_TRACE_MODE_SET: ReadonlySet<string> = new Set(BASE_TRACE_MODES)
type BaseTraceMode = (typeof BASE_TRACE_MODES)[number]
type ToolTraceMode = BaseTraceMode | "full"

type Config = {
  baseUrl: string
  workspaceId: string
  apiKey: string
  pollMs?: number
  instanceId?: string
  defaultDisplayName?: string
  /** Pinned model identifiers (`provider/id`) rendered first by /model. */
  preferredModels?: string[]
  /** Label name to assign to scratchpads created by this Pi instance. */
  defaultLabel?: string
  /**
   * Emit FULL trace detail (real commands, file contents, patches, tool
   * output) on a sealed (E2EE) turn. Safe because sealed step content is
   * ciphertext the server can't read — the point is giving the owner more
   * without giving the server anything. Defaults to ON for sealed turns; has
   * no effect on plaintext turns, which never emit full detail (the toggle can
   * never leak full tool payloads to the server). Set `false` to use the
   * configured `traceMode` on sealed turns too.
   */
  sealedFullTrace?: boolean
  /**
   * Base trace detail. `headline` keeps shell commands hidden; `commands`
   * includes only the Bash command while file bodies, patches, and every tool
   * result stay hidden. Used for plaintext turns and sealed turns when
   * `sealedFullTrace` is false. Defaults to `headline`.
   */
  traceMode?: BaseTraceMode
  /**
   * Create new linked scratchpads end-to-end encrypted: the harness mints the
   * stream key and wraps it to the bot owner's UIK + its own BIK, so the
   * server only ever stores ciphertext. Requires the owner to have set up
   * encryption in Threa. Off by default (an encrypted scratchpad opts out of
   * GAM memory extraction).
   */
  e2e?: boolean
  /** Legacy global flag; migrated to per-session link state on write. */
  enabled?: boolean
  linkedSessions?: Record<string, RuntimeSessionLink>
  /** Legacy global cursors; migrated to per-session link state on write. */
  streamCursors?: Record<string, string>
}

type RuntimeSessionLink = {
  linkId: string
  rootStreamId: string
  activeStreamId: string
  runtimeSessionId: string
  streamUrlPath: string
  /** The linked scratchpad's encryption state (create echoes the request; resume reports reality). */
  e2eEnabled?: boolean
  instanceId?: string
  enabled?: boolean
  debugPolling?: boolean
  streamCursors?: Record<string, string>
  /**
   * Server-stamped ISO timestamp from the last `bot:hello` bootstrap.
   * Sent back as `sinceCursor` on reconnect so the server can scope the
   * pending-invocation replay to rows we haven't already seen.
   */
  wsCursor?: string
}

type ConfigPatch = Pick<
  Config,
  | "baseUrl"
  | "workspaceId"
  | "apiKey"
  | "pollMs"
  | "defaultDisplayName"
  | "preferredModels"
  | "defaultLabel"
  | "sealedFullTrace"
  | "traceMode"
  | "e2e"
>

type ClaimedInvocation = {
  id: string
  activeStreamId: string
  /** Root stream that owns the E2E key — the AAD stream id for sealed wraps/messages. */
  rootStreamId?: string
  sourceMessageId: string
  sourceRevision: number
  promptMarkdown: string
  claimToken: string
  claimedInstanceId?: string
  claimExpiresAt: string | null
  trigger?: string
  requiredCapability?: string
  metadata?: Record<string, unknown>
  /** Present on a sealed (E2E) claim; absent on plaintext. The bot opened it with its BIK at claim time. */
  sealing?: SealingState
  sealedIdentity?: BotIdentityKey
  /** Decrypted prior-message context, pre-formatted for the prompt (no plaintext fetch on E2E). */
  sealedContextText?: string
  /** Immutable history text/attachment paths retained while source attachments are replaced by edits. */
  sealedHistoryContextText?: string
  /** Decrypted attachment paths to include in a concise mid-turn steer. */
  sealedSteerContextText?: string
  sealedSourceAttachmentRefs?: AttachmentRef[]
  sealedHistoryAttachmentRefs?: AttachmentRef[]
  /** Present on a session-control claim on an E2E stream: SSK wraps to seal the command ack. */
  sealedAck?: unknown
}

interface AttachmentSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

interface StreamMessage {
  id: string
  authorType: string
  authorDisplayName?: string
  sequence: string
  content: string
  createdAt: string
  attachments?: AttachmentSummary[]
}

interface UploadedAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

interface BotPrincipal {
  kind: "bot"
  workspaceId: string
  botId: string
  botType: string
  traits: string[]
  ownerUserId: string
}

let config: Config | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let pollInFlightRunId: number | undefined
let pending: ClaimedInvocation | undefined
type SteeredInvocation = { invocation: ClaimedInvocation; cursor?: string; retryPrompt: string }
let steeredInvocations: SteeredInvocation[] = []
let pendingContextCursor: string | undefined
let pendingInvocationPrompt: string | undefined
let pendingRetry: { timer?: ReturnType<typeof setTimeout>; retryAt: number; attempts: number } | undefined
let isWaitingForRetry = false
let promptEpoch = 0
let awaitingTurnStart = false
type PendingOutputState = {
  epoch: number
  invocation: ClaimedInvocation
  revision: number
  assistantTexts: string[]
  nonAssistantTexts: Array<{ role: string; text: string }>
  toolCalls: Map<string, { headline: string }>
  providerError?: string
  modelError?: string
  retryAfterMs?: number
}
let activeOutputState: PendingOutputState | undefined
let carryOnTexts: string[] = []
let lastTraceHeartbeat: { text: string; at: number } | undefined
type ObservedInvocationState = "unstarted" | "processing" | "running" | "recovery" | "terminalizing" | "terminal"
type ObservedInvocationContext = {
  invocation: ClaimedInvocation
  handle: ObservedClaimHandle
  state: ObservedInvocationState
  updateInProgress: boolean
  restartRequested: boolean
  abortIssued: boolean
  ctx: ExtensionContext
  pi: ExtensionAPI
}
const observedInvocations = new Map<ClaimedInvocation, ObservedInvocationContext>()
const cancelledInvocations = new WeakSet<ClaimedInvocation>()
type ContributorTerminalWrite = {
  invocation: ClaimedInvocation
  phase: "complete" | "fail"
  failAttempts: number
  running?: Promise<boolean>
  timer?: ReturnType<typeof setTimeout>
  ctx?: ExtensionContext
}
const contributorTerminalWrites = new Map<ClaimedInvocation, ContributorTerminalWrite>()
let primaryCompletionCommitted = false
let activeControlInvocation: ClaimedInvocation | undefined
let consecutivePollFailures = 0
let consecutiveQuietPolls = 0
let lastPollFailureSummary: string | undefined
let lastBusyHeartbeatAt = 0
let lastPollDebugSummary: string | undefined
let pollingRunId = 0
let fallbackRuntimeSessionId: string | undefined
let supervisedRevivalBlocked = false
let reconnectPending = false
let reloadPending = false
let claimIfIdleInFlight: Promise<boolean> | undefined
let pendingSettlement: Promise<void> | undefined
let recoveredCompletionTimer: ReturnType<typeof setTimeout> | undefined
let claimIfIdleRerunRequested = false
let sessionLifecycleGeneration = 0
let sessionTearingDown = false
// Set while the linked scratchpad is archived and the session is waiting out
// the restore grace window: claims are suspended, the poll probes at the
// reattach cadence, and the deadline runs the worktree wind-down.
// The archive → grace → wind-down machine, shared with the Claude runtime.
// Built lazily because every hook needs the extension ctx.
let archive: ArchiveGraceController | undefined
// Set by startPolling so a detach can pull the next tick forward: the pending
// tick was scheduled with the socket backstop (15 min), which lands ZERO
// reattach probes inside a 5-minute grace.
let rearmPoll: ((delayMs: number) => void) | undefined
// Overridable so a test can watch the grace expire and the wind-down run
// instead of waiting five minutes and killing the tmux window it runs in.
let archiveGraceMs: number | undefined
let archiveKillWindow: typeof killOwnWindow = killOwnWindow
// Owns the /bot socket + routes presence/renew/steps over it (HTTP fallback
// when the socket is down). Built lazily once the session ctx is known; torn
// down + rebuilt on a workspace/auth change so it never reuses a stale target.
let transport: BotRuntimeTransport | undefined
// This install's BIK. `ensure()`d before the first presence write so the public
// half rides every hello/presence body — the backend's instance upsert
// overwrites the stored key by default, so omitting it on a heartbeat would
// clear the registration and break sealed-claim wrap coverage.
function createBikKeystore(path: string): BikKeystore {
  return new BikKeystore({
    path,
    log: (message) => console.error(`Threa remote: ${message}`),
  })
}

let bikKeystore = createBikKeystore(BIK_PATH)

function validateConfig(value: unknown): Config | undefined {
  if (!value || typeof value !== "object") {
    console.error(`Invalid ${CONFIG_PATH}: expected an object`)
    return undefined
  }
  const candidate = value as Partial<Config>
  const invalidFields = ["baseUrl", "workspaceId", "apiKey"].filter((field) => {
    const fieldValue = candidate[field as keyof Config]
    return typeof fieldValue !== "string" || fieldValue.trim().length === 0
  })
  if (invalidFields.length > 0) {
    console.error(`Invalid ${CONFIG_PATH}: missing or invalid ${invalidFields.join(", ")}`)
    return undefined
  }
  if (candidate.defaultLabel !== undefined) {
    if (typeof candidate.defaultLabel !== "string") {
      console.error(`Invalid ${CONFIG_PATH}: defaultLabel must be a string`)
      return undefined
    }
    candidate.defaultLabel = candidate.defaultLabel.trim() || undefined
  }
  if (candidate.traceMode !== undefined && !BASE_TRACE_MODE_SET.has(candidate.traceMode)) {
    console.error(`Invalid ${CONFIG_PATH}: traceMode must be headline or commands`)
    return undefined
  }
  return migrateSessionState(candidate as Config)
}

function readStoredConfig(): Partial<Config> | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<Config>) : undefined
  } catch (error) {
    console.error(`Failed to parse ${CONFIG_PATH}: ${String(error)}`)
    return undefined
  }
}

function migrateSessionState(candidate: Config): Config {
  if (!candidate.linkedSessions || typeof candidate.linkedSessions !== "object") return candidate
  for (const [sessionId, link] of Object.entries(candidate.linkedSessions)) {
    if (!link || typeof link !== "object") {
      delete candidate.linkedSessions[sessionId]
      continue
    }
    link.enabled ??= candidate.enabled ?? true
    if (!link.streamCursors && candidate.streamCursors) {
      const cursor = candidate.streamCursors[link.activeStreamId] ?? candidate.streamCursors[link.rootStreamId]
      if (cursor) link.streamCursors = { [link.activeStreamId]: cursor }
    }
  }
  return candidate
}

function readConfig(): Config | undefined {
  const stored = readStoredConfig()
  return stored ? validateConfig(stored) : undefined
}

// Cross-process lock for `~/.pi/agent/threa-remote.json` so two Pi instances
// sharing the file can't interleave a read-merge-write and clobber each
// other's `linkedSessions` entry. Mirrors pi's own `FileSettingsStorage`
// `acquireLockSyncWithRetry` (which locks `settings.json` the same way) but
// uses a zero-dependency O_EXCL lockfile instead of pulling `proper-lockfile`
// into this runtime-loaded package. If the lock can't be acquired the save is
// skipped (never an unlocked RMW — that would reintroduce the clobber), and
// the owning instance's next save self-heals.
let CONFIG_LOCK_PATH = `${CONFIG_PATH}.lock`
const CONFIG_LOCK_MAX_ATTEMPTS = 10
const CONFIG_LOCK_DELAY_MS = 25

function acquireConfigLockSync(): (() => void) | undefined {
  for (let attempt = 1; attempt <= CONFIG_LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number | undefined
    try {
      // O_EXCL + O_CREAT: the open succeeds only for the creator of the file,
      // giving us an exclusive cross-process lock. `wx` flag = O_EXCL|O_CREAT|O_WRONLY.
      fd = openSync(CONFIG_LOCK_PATH, "wx")
      const release = (): void => {
        try {
          closeSync(fd!)
          unlinkSync(CONFIG_LOCK_PATH)
        } catch {
          // Already cleaned up by another path; nothing to do.
        }
      }
      return release
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined
      if (code !== "EEXIST") {
        // Unexpected error (permissions, disk full, …) — skip this save
        // rather than perform an unlocked RMW (INV-20).
        console.error(`Threa remote: config lock acquire failed; skipping save: ${String(error)}`)
        return undefined
      }
      // EEXIST: another instance holds the lock. Stale-lock guard: if the lock
      // file is older than a few seconds, the holder likely crashed — reclaim it.
      try {
        const stats = statSync(CONFIG_LOCK_PATH)
        if (Date.now() - stats.mtimeMs > 5000) {
          unlinkSync(CONFIG_LOCK_PATH)
          continue // retry immediately on next iteration
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry.
        continue
      }
      if (attempt < CONFIG_LOCK_MAX_ATTEMPTS) {
        const start = Date.now()
        while (Date.now() - start < CONFIG_LOCK_DELAY_MS) {
          // Synchronous spin — mirrors pi's settings lock; keep the RMW
          // critical section simple to reason about (no async reentrancy).
        }
      }
    }
  }
  // Timed out waiting — skip this save rather than write unlocked (INV-20).
  console.error("Threa remote: config lock timed out; skipping save")
  return undefined
}

function buildPersistedConfig(inMemory: Config, onDisk: Partial<Config> | undefined): Record<string, unknown> {
  // Start from on-disk fields so hand-edited / unknown top-level keys the
  // runtime doesn't manage survive the write. Overlay every field the runtime
  // has in-memory but skip undefined optionals so a hand-edited defaultLabel
  // on disk isn't erased by the runtime's unset optional.
  const persisted: Record<string, unknown> = { ...(onDisk ?? {}) }
  const inMemoryStreamCursors = inMemory.streamCursors
  for (const [key, value] of Object.entries(inMemory)) {
    if (value !== undefined) persisted[key] = value
  }
  // enabled is migrated to per-session link state; strip the global flag.
  // streamCursors is merged below and written only when either side is non-empty.
  delete persisted.enabled
  delete persisted.streamCursors
  // Merge linkedSessions so concurrent Pi instances (each owning a distinct key,
  // keyed by runtimeSessionId) don't clobber each other's links (INV-20).
  if (onDisk?.linkedSessions && inMemory.linkedSessions) {
    persisted.linkedSessions = { ...onDisk.linkedSessions, ...inMemory.linkedSessions }
  }
  // Legacy global cursors: merge either side. Migrated into per-link
  // streamCursors by migrateSessionState; this branch only matters for
  // upgraded installs that still carry the global map on disk.
  if (onDisk?.streamCursors || inMemoryStreamCursors) {
    persisted.streamCursors = { ...(onDisk?.streamCursors ?? {}), ...(inMemoryStreamCursors ?? {}) }
  }
  return persisted
}

function saveConfig(): void {
  if (!config) return
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  const release = acquireConfigLockSync()
  if (!release) return
  try {
    const persisted = buildPersistedConfig(config, readStoredConfig())
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(persisted, null, 2)}\n`)
    renameSync(tmp, CONFIG_PATH)
  } finally {
    release()
  }
}

// Server `bot:hello` schema constrains `instanceId` to `^[A-Za-z0-9_-]+$`
// (see backend `socket-handler.ts`). macOS `hostname()` returns values like
// `kristoffers-mbp.lan` — the literal dot breaks the regex and the handshake
// rejects every connect, silently degrading the plugin to a 30s WS backstop
// poll. Sanitize at the boundary and migrate previously-persisted bad ids.
const INSTANCE_ID_REGEX = /^[A-Za-z0-9_-]+$/
const INSTANCE_ID_UNSAFE_CHARS = /[^A-Za-z0-9_-]+/g
const INSTANCE_ID_MAX_CHARS = 64

function sanitizeInstanceIdSegment(raw: string): string {
  return raw.replace(INSTANCE_ID_UNSAFE_CHARS, "-").replace(/^-+|-+$/g, "")
}

function createRandomInstanceId(): string {
  return `pi-${crypto.randomUUID().slice(0, 8)}`
}

function createInstanceId(): string {
  const suffix = crypto.randomUUID().slice(0, 8)
  const host = sanitizeInstanceIdSegment(hostname())
  const maxHostChars = INSTANCE_ID_MAX_CHARS - "pi--".length - suffix.length
  const trimmedHost = host.slice(0, Math.max(0, maxHostChars)).replace(/-+$/g, "")
  return trimmedHost.length > 0 ? `pi-${trimmedHost}-${suffix}` : `pi-${suffix}`
}

function instanceIdForRemoteCreate(runtimeSessionId: string): string {
  if (process.env.THREA_RUNTIME_SESSION_ID !== runtimeSessionId) return createInstanceId()
  const launchedInstanceId = process.env.THREA_INSTANCE_ID
  if (
    launchedInstanceId === undefined ||
    !INSTANCE_ID_REGEX.test(launchedInstanceId) ||
    launchedInstanceId.length > INSTANCE_ID_MAX_CHARS
  ) {
    throw new Error("THREA_INSTANCE_ID must be 1-64 letters, numbers, underscores, or hyphens")
  }
  return launchedInstanceId
}

function migrateInstanceId(stored: unknown): string {
  // `config.instanceId` is loaded via `JSON.parse` and `readConfig` only
  // type-checks the three required fields. A hand-edited config could put
  // anything here, so accept `unknown` and treat non-strings as missing.
  if (typeof stored !== "string" || stored.length === 0) return createRandomInstanceId()
  const cleaned = INSTANCE_ID_REGEX.test(stored) ? stored : sanitizeInstanceIdSegment(stored)
  if (cleaned.length === 0) return createRandomInstanceId()
  return cleaned.length <= INSTANCE_ID_MAX_CHARS ? cleaned : cleaned.slice(0, INSTANCE_ID_MAX_CHARS).replace(/-+$/g, "")
}

function ensureInstanceId(): string {
  if (!config) throw new Error("Threa remote config not loaded")
  if (typeof config.instanceId === "string" && config.instanceId.length > 0) {
    const migrated = migrateInstanceId(config.instanceId)
    if (migrated !== config.instanceId) {
      config.instanceId = migrated
      saveConfig()
    }
    return config.instanceId
  }
  config.instanceId = createInstanceId()
  saveConfig()
  return config.instanceId
}

function getSessionInstanceId(ctx: ExtensionContext): string {
  const link = getCurrentSessionLink(ctx)
  if (!link?.instanceId) return ensureInstanceId()
  const migrated = migrateInstanceId(link.instanceId)
  if (migrated !== link.instanceId) {
    link.instanceId = migrated
    saveConfig()
  }
  return link.instanceId
}

function getInvocationInstanceId(invocation: ClaimedInvocation): string {
  return invocation.claimedInstanceId ?? ensureInstanceId()
}

// Tildified cwd for the bot presence pill. The scratchpad UI shows this as
// the "where Pi is running" hint, so a shell-style `~/dev/foo` reads better
// than the static "Local Pi" we used to send.
function presenceDisplayNameFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  const home = homedir()
  const isUnderHome = cwd === home || cwd.startsWith(`${home}/`)
  const labeled = isUnderHome ? `~${cwd.slice(home.length)}` : cwd
  // `upsertPresenceSchema` caps `displayName` at 100 chars; the strip CSS-truncates
  // anything longer, but keep the wire payload inside the validator's limit.
  return labeled.length > 100 ? labeled.slice(-100) : labeled
}

function getRuntimeSessionId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId()
  if (sessionId) return sessionId
  fallbackRuntimeSessionId ??= `pi-session-${Date.now()}`
  return fallbackRuntimeSessionId
}

function getCurrentSessionLink(ctx: ExtensionContext): RuntimeSessionLink | undefined {
  if (!config?.linkedSessions) return undefined
  return config.linkedSessions[getRuntimeSessionId(ctx)]
}

function setCurrentSessionEnabled(ctx: ExtensionContext, enabled: boolean): RuntimeSessionLink | undefined {
  const link = getCurrentSessionLink(ctx)
  if (!link) return undefined
  link.enabled = enabled
  saveConfig()
  return link
}

function buildScratchpadUrl(baseUrl: string, workspaceId: string, streamId: string): string {
  // The frontend route is `/w/:workspaceId/s/:streamId`. Older server versions
  // returned `streamUrlPath: /streams/<id>` (no workspace prefix) and that
  // value is persisted in `config.linkedSessions` for upgraded installs, so we
  // can't trust the stored path. Compose locally from data the client owns —
  // it's stable across server format changes and migrates existing links for
  // free without touching disk.
  return new URL(`/w/${workspaceId}/s/${streamId}`, baseUrl).toString()
}

async function openExternalUrl(url: string): Promise<void> {
  const os = platform()
  if (os === "darwin") {
    try {
      await execFileAsync("open", ["-a", "Threa", url], { timeout: OPEN_URL_TIMEOUT_MS })
      return
    } catch {
      await execFileAsync("open", [url], { timeout: OPEN_URL_TIMEOUT_MS })
      return
    }
  }
  if (os === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url], { timeout: OPEN_URL_TIMEOUT_MS })
    return
  }
  await execFileAsync("xdg-open", [url], { timeout: OPEN_URL_TIMEOUT_MS })
}

function isCurrentSessionEnabled(ctx: ExtensionContext): boolean {
  return getCurrentSessionLink(ctx)?.enabled === true
}

function isPollDebugEnabled(ctx: ExtensionContext): boolean {
  return getCurrentSessionLink(ctx)?.debugPolling === true
}

function setPollDebug(ctx: ExtensionContext, enabled: boolean): boolean {
  const link = getCurrentSessionLink(ctx)
  if (!link) return false
  link.debugPolling = enabled
  saveConfig()
  return true
}

function emitPollDebug(ctx: ExtensionContext, summary: string): void {
  lastPollDebugSummary = `${new Date().toISOString()} ${summary}`
  if (!isPollDebugEnabled(ctx)) return
  ctx.ui.notify(`Threa remote poll: ${summary}`, "info")
}

function setRemoteStatus(ctx: ExtensionContext, text: string, tone: "muted" | "error" = "muted"): void {
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(tone, text))
}

function summarizeError(error: unknown): string {
  const cause =
    error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined
  const causeCode =
    cause && typeof cause === "object" && "code" in cause ? String((cause as { code?: unknown }).code) : ""
  const message = error instanceof Error ? error.message : String(error)
  return [message, causeCode ? `(${causeCode})` : ""].filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 180)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted")
}

class ThreaApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config) throw new Error("Threa remote config not loaded")
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData
  // One abort window over headers AND body. Clearing the timer once headers
  // arrived left the `response.json()` below unbounded — a response whose body
  // then stalls hangs its caller forever, and a hung await inside the poll loop
  // parks the loop with no timer armed: presence freezes while the pane still
  // says "linked". That is the recurring split-brain, so the window closes only
  // after the body is consumed.
  const controller = new AbortController()
  // The caller's signal must reach this controller: a cancelled invocation
  // aborts in-flight requests through it, and `signal: controller.signal`
  // below would otherwise override whatever `init` supplied.
  const callerSignal = init?.signal ?? undefined
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true })
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(!isFormData && { "Content-Type": "application/json" }),
        ...init?.headers,
      },
    })
    return await readRequestBody<T>(response)
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener("abort", abortFromCaller)
  }
}

async function readRequestBody<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // Surface the server's JSON error (Zod `fieldErrors`, `code`, ...) when the
    // API itself rejects the request, so a 400 is debuggable instead of a bare
    // "Bad Request". Guard against huge HTML proxy/CGI error pages: only read
    // the body for JSON responses and cap it, so a 502 from a reverse proxy
    // still can't dump a megabyte of markup into Pi.
    let detail = ""
    let errorCode: string | undefined
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("application/json")) {
      try {
        const body = await response.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = null
        }
        if (parsed && typeof parsed === "object") {
          const err = parsed as Record<string, unknown>
          const nestedError =
            err.error && typeof err.error === "object" ? (err.error as Record<string, unknown>) : undefined
          errorCode =
            typeof err.code === "string"
              ? err.code
              : typeof nestedError?.code === "string"
                ? nestedError.code
                : undefined
          const parts = [
            typeof err.error === "string" ? err.error : "",
            errorCode ? `[${errorCode}]` : "",
            err.details ? `details=${JSON.stringify(err.details)}` : "",
          ].filter(Boolean)
          detail = parts.join(" ")
        }
        if (!detail) detail = body.replace(/\s+/g, " ").trim()
      } catch {
        detail = ""
      }
    }
    detail = detail.slice(0, 500)
    throw new ThreaApiError(
      response.status,
      `Threa API ${response.status}: ${response.statusText}${detail ? ` — ${detail}` : ""}`,
      errorCode
    )
  }
  return (await response.json()) as T
}

function buildModelSuggestions(ctx: ExtensionContext): Array<{ value: string; label: string }> {
  const preferred = new Set((config?.preferredModels ?? []).map((value) => value.toLowerCase()))
  const ordered = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name }))
  ordered.sort((a, b) => {
    const aPref = preferred.has(a.value.toLowerCase())
    const bPref = preferred.has(b.value.toLowerCase())
    if (aPref !== bPref) return aPref ? -1 : 1
    return 0
  })
  return ordered.slice(0, 30)
}

function currentSessionControlLink(ctx: ExtensionContext): RuntimeSessionLink | undefined {
  const link = getCurrentSessionLink(ctx)
  if (
    link?.enabled !== true ||
    typeof link.rootStreamId !== "string" ||
    link.rootStreamId.trim().length === 0 ||
    link.runtimeSessionId !== getRuntimeSessionId(ctx) ||
    link.instanceId !== getSessionInstanceId(ctx) ||
    !process.env.TMUX_PANE
  ) {
    return undefined
  }
  return link
}

function currentReconnectLink(
  ctx: ExtensionContext,
  reconnectAvailable: () => boolean = harnessReconnectAvailable
): RuntimeSessionLink | undefined {
  const link = currentSessionControlLink(ctx)
  return link && reconnectAvailable() ? link : undefined
}

function buildRuntimeCapabilities(
  ctx?: ExtensionContext,
  reconnectAvailable: () => boolean = harnessReconnectAvailable
): Record<string, unknown> {
  return {
    supportsActiveScratchpad: true,
    supportsPersistentSessions: true,
    supportsMentionInvocations: true,
    supportsSessionControlCommands: true,
    sessionControlCommands: SESSION_CONTROL_COMMANDS.filter((command) => {
      // Commands routed through the harnessd entrypoint need this session's tmux
      // pane and an installed daemon; the rest actuates in-process through the
      // extension API and needs no tmux at all.
      if (command === "kick" || command === "reconnect" || command === "clear") {
        return Boolean(ctx && currentReconnectLink(ctx, reconnectAvailable))
      }
      if (command === "spawn" || command === "done") {
        const link = ctx ? currentReconnectLink(ctx, reconnectAvailable) : undefined
        if (!link) return false
        // `/spawn` opens a thread under the desk's root; `/done` winds down the
        // thread session it is run from.
        const onDesk = link.activeStreamId === link.rootStreamId
        return command === "spawn" ? onDesk : !onDesk
      }
      if (command === "key") return Boolean(ctx && currentSessionControlLink(ctx))
      return true
    }),
    thinkingLevels: [...THINKING_LEVELS],
    preferredModels: [...(config?.preferredModels ?? [])],
    ...(ctx?.model && { currentModel: `${ctx.model.provider}/${ctx.model.id}` }),
    ...(ctx && { modelSuggestions: buildModelSuggestions(ctx) }),
  }
}

function presenceBody(status: "available" | "busy" | "offline" | "error", statusText?: string, ctx?: ExtensionContext) {
  const effectiveStatus = status === "available" && (reconnectPending || reloadPending) ? "busy" : status
  return {
    runtimeKind: "pi-local",
    instanceId: ctx ? getSessionInstanceId(ctx) : ensureInstanceId(),
    runtimeSessionId: ctx ? getRuntimeSessionId(ctx) : undefined,
    displayName: presenceDisplayNameFromCwd(ctx?.cwd) ?? config?.defaultDisplayName,
    status: effectiveStatus,
    acceptingInvocations: effectiveStatus === "available",
    manifest: PI_MANIFEST,
    capabilities: buildRuntimeCapabilities(ctx),
    statusText,
    ...bikKeystore.presenceFields(),
  }
}

async function heartbeat(
  status: "available" | "busy" | "offline" | "error",
  statusText?: string,
  ctx?: ExtensionContext
): Promise<void> {
  if (!config || (sessionTearingDown && status !== "offline")) return
  // Cached after the first call; awaiting here guarantees no presence write
  // ever omits the BIK (the upsert would clear the registered key).
  await bikKeystore.ensure()
  const body = presenceBody(status, statusText, ctx)
  // Prefer the socket once the transport exists (it falls back to HTTP itself
  // when the socket is down); before the transport is built (a heartbeat that
  // fires pre-enable) go straight to HTTP.
  if (transport) {
    await transport.updatePresence(body)
  } else {
    await request(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/presence`, {
      method: "POST",
      body: JSON.stringify(body),
    })
  }
}

async function heartbeatBusyIfStale(statusText = "Working…", ctx?: ExtensionContext): Promise<boolean> {
  const now = Date.now()
  if (now - lastBusyHeartbeatAt < BUSY_HEARTBEAT_MS) return false
  lastBusyHeartbeatAt = now
  await heartbeat("busy", statusText, ctx)
  return true
}

/**
 * Build (once) the transport that owns the `/bot` socket for this Pi session.
 * The hello capabilities are a snapshot — model/thinking changes still reach the
 * server via the per-turn presence updates, which carry fresh capabilities — and
 * the cold-start cursor comes from the persisted session link so the bootstrap
 * only replays unseen events. The transport persists each new cursor back via
 * `onBootstrap`. Returns undefined only when no config is loaded.
 */
function ensureTransport(pi: ExtensionAPI, ctx: ExtensionContext): BotRuntimeTransport | undefined {
  if (!config) return undefined
  if (transport) return transport
  const hello: BotRuntimeHello = {
    ...presenceBody(reconnectPending || pending || !ctx.isIdle() ? "busy" : "available", undefined, ctx),
    supportedCapabilities: ["active-scratchpad", "mentionable", SESSION_CONTROL_CAPABILITY],
    ...(getCurrentSessionLink(ctx)?.wsCursor ? { sinceCursor: getCurrentSessionLink(ctx)?.wsCursor } : {}),
  }
  transport = new BotRuntimeTransport({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    apiKey: config.apiKey,
    hello,
    beforeHello: () =>
      Object.assign(
        hello,
        presenceBody(reconnectPending || pending || !ctx.isIdle() ? "busy" : "available", undefined, ctx)
      ),
    reconnectionDelayMaxMs: WS_RECONNECTION_DELAY_MAX_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
    callbacks: {
      onInvocationAvailable: () => void claimIfIdle(pi, ctx).catch(() => undefined),
      onBootstrap: (bootstrap) => {
        if (bootstrap.serverGeneratedAt) {
          const current = getCurrentSessionLink(ctx)
          if (current) {
            current.wsCursor = bootstrap.serverGeneratedAt
            saveConfig()
          }
        }
        // A reconnect is exactly when an archive push went missing, so
        // re-derive before trusting the link the bootstrap arrived on.
        void probeArchiveState(ctx)
        if (bootstrap.availableInvocations.length > 0 || bootstrap.ownedClaims.length > 0) {
          void claimIfIdle(pi, ctx).catch(() => undefined)
        }
      },
      onDisconnected: () => handleTransportDisconnected(),
      onSessionArchived: (payload) => handleArchivePush(ctx, payload),
      onSessionRestored: (payload) => handleRestorePush(ctx, payload),
    },
    log: (summary) => emitPollDebug(ctx, `ws ${summary}`),
  })
  return transport
}

/**
 * Drop the socket and forget the transport so the next enable/configure rebuilds
 * it fresh — `BotRuntimeTransport.disconnect()` is terminal (it won't reconnect),
 * which is exactly what we want when the workspace/auth target changes.
 */
function teardownTransport(): void {
  transport?.disconnect()
  transport = undefined
}

function truncateForTrace(text: string, max = TRACE_CONTENT_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n\n…[trace content truncated; ${trimmed.length - max} more characters]`
}

async function recordInvocationTraceStep(
  invocation: ClaimedInvocation,
  stepType: string,
  content: string,
  statusText?: string
): Promise<void> {
  if (!config) return
  // Session-control claims have no agent session server-side, so the server
  // can never persist their steps — it rejects each one (an INTERNAL_ERROR ack
  // before SESSION_CONTROL_TRACE_UNSUPPORTED existed). Presence heartbeats
  // carry the "Running /x…" status instead.
  if (invocation.trigger === "session-control") return
  const revision = invocation.sourceRevision
  const sealing = invocation.sealing
  const observed = observedInvocations.get(invocation) ?? null
  if (!isInvocationWriteCurrent(invocation, revision, observed) || observed?.updateInProgress) return
  const isCurrent = () =>
    isInvocationWriteCurrent(invocation, revision, observed) &&
    invocation.sealing === sealing &&
    !observed?.updateInProgress
  const trimmed = truncateForTrace(
    content,
    invocation.sealing ? SEALED_TRACE_CONTENT_MAX_CHARS : TRACE_CONTENT_MAX_CHARS
  )
  if (!trimmed) return
  // Sealed turn: the step content is sealed under the stream key and posted to
  // the sealed wire (WS frame first, HTTP /sealed-steps fallback). No
  // statusText — the sealed wire deliberately carries none (a plaintext status
  // derived from sealed content would leak); the whitelisted busy heartbeats
  // cover the presence strip.
  if (sealing) {
    try {
      const frame = await sealStep(sealing, stepType, trimmed)
      if (!isCurrent()) return
      if (transport) {
        await transport.recordSealedSteps(invocation.id, sealing.callbackToken, [frame])
      } else {
        await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/sealed-steps`, {
          method: "POST",
          headers: { [THREA_CALLBACK_TOKEN_HEADER]: sealing.callbackToken },
          body: JSON.stringify(frame),
        })
      }
    } catch {
      // Best-effort like the plaintext path: a dropped step dulls the trace,
      // never aborts the turn.
    }
    return
  }
  const status = statusText?.trim().slice(0, 160)
  // High-volume, best-effort path (one per tool call + per assistant message,
  // 150+ in a long turn). The transport routes these over the socket — the cost
  // win — and doesn't reject (its HTTP fallback swallows); the `.catch` is the
  // safety boundary so a dropped trace step only dulls the trace, never aborts
  // the turn.
  if (transport) {
    if (!isCurrent()) return
    await transport
      .recordSteps(
        invocation.id,
        invocation.claimToken,
        [{ stepType, content: trimmed }],
        status,
        getInvocationInstanceId(invocation)
      )
      .catch(() => undefined)
    return
  }
  if (!isCurrent()) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/steps`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: getInvocationInstanceId(invocation),
      claimToken: invocation.claimToken,
      stepType,
      content: trimmed,
      statusText: status,
    }),
  }).catch(() => undefined)
}

async function recordTraceStep(stepType: string, content: string, statusText?: string): Promise<void> {
  if (!pending) return
  await recordInvocationTraceStep(pending, stepType, content, statusText)
}

async function traceHeartbeat(text: string, ctx?: ExtensionContext, stepType?: string): Promise<void> {
  if (!pending) return
  const trimmed = safeStatusText(text)
  if (!trimmed) return
  const now = Date.now()
  if (lastTraceHeartbeat?.text === trimmed && now - lastTraceHeartbeat.at < 5000) return
  lastTraceHeartbeat = { text: trimmed, at: now }
  if (stepType) {
    await recordTraceStep(stepType, trimmed, trimmed)
    return
  }
  // `ctx` carries the cwd-derived displayName and runtimeSessionId into the
  // heartbeat body. Dropping it makes the server's upsert wipe runtimeSessionId
  // out of `capabilities`, and `broadcastBotPresence` then emits `presence:
  // null` for the linked scratchpad — the strip flickers to "Not connected"
  // mid-turn.
  await heartbeat("busy", trimmed, ctx).catch(() => undefined)
}

function safeStatusText(text: string): string {
  const trimmed = text.trim()
  const allowed = new Set([
    "Thinking…",
    "Loaded context…",
    "Running shell command…",
    "Reading file…",
    "Reading sensitive file…",
    "Writing file…",
    "Editing file…",
    "Searching files…",
    "Listing directory…",
    "Using tool…",
    "Tool finished",
    "Tool failed",
    "Composing response…",
    "Sent response",
  ])
  if (allowed.has(trimmed)) return trimmed
  if (/^Finished [A-Za-z0-9_-]+$/.test(trimmed)) return "Tool finished"
  if (/^[A-Za-z0-9_-]+ failed$/.test(trimmed)) return "Tool failed"
  return "Working…"
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function basenameFromInputPath(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1)
}

function isSensitivePath(path: unknown): boolean {
  if (typeof path !== "string") return false
  return /(^|[\\/.])(?:env|npmrc|netrc|pypirc|pgpass|aws|credentials|config|secrets?|tokens?|keys?)(?:$|[.\\/-])/i.test(
    path
  )
}

function safeFileSummary(path: unknown): string {
  if (isSensitivePath(path)) return "sensitive file"
  const name = basenameFromInputPath(path)
  return name ? `file ${name}` : "file"
}

function safeToolName(toolName: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(toolName) ? toolName : "tool"
}

function describeToolCall(event: ToolCallEvent): string {
  const input = "input" in event ? event.input : undefined
  const toolName = safeToolName(event.toolName)
  if (event.toolName === "bash") return "Running shell command…"
  if ((event.toolName === "read" || event.toolName === "write") && isObject(input) && "path" in input) {
    if (event.toolName === "read" && isSensitivePath(input.path)) return "Reading sensitive file…"
    return `${event.toolName === "read" ? "Reading" : "Writing"} ${safeFileSummary(input.path)}…`
  }
  if (event.toolName === "edit" && isObject(input) && "path" in input) return `Editing ${safeFileSummary(input.path)}…`
  if (event.toolName === "grep" || event.toolName === "find") return "Searching files…"
  if (event.toolName === "ls") return "Listing directory…"
  return `Using ${toolName}…`
}

function textFromToolContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object" || !("type" in part)) return ""
      if (part.type === "text" && "text" in part) return String(part.text)
      if (part.type === "image") return "[image output]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function formatStructuredToolTrace(params: {
  headline: string
  sections: Array<{ label: PiToolTraceSectionLabel; body: string; lang: string | null }>
  maxChars?: number
}): string {
  const maxChars = params.maxChars ?? TRACE_CONTENT_MAX_CHARS
  const sections = params.sections.map((section) => ({ ...section, originalBody: section.body }))

  for (let attempt = 0; attempt < 24; attempt++) {
    const payload = JSON.stringify({
      format: PI_TOOL_TRACE_FORMAT,
      headline: params.headline,
      sections: sections.map(({ originalBody: _originalBody, ...section }) => section),
    })
    if (payload.length <= maxChars) return payload

    const largestIndex = sections.reduce(
      (largest, section, index) => (section.body.length > sections[largest]!.body.length ? index : largest),
      0
    )
    const largest = sections[largestIndex]
    if (!largest || largest.originalBody.length === 0) break

    const overflow = payload.length - maxChars
    const currentVisibleLength = largest.body.includes("…[section truncated;")
      ? largest.body.indexOf("\n\n…[section truncated;")
      : largest.body.length
    const nextVisibleLength = Math.max(0, currentVisibleLength - Math.max(overflow + 256, 512))
    const omitted = largest.originalBody.length - nextVisibleLength
    largest.body = `${largest.originalBody.slice(0, nextVisibleLength).trimEnd()}\n\n…[section truncated; ${omitted} more characters]`
  }

  return JSON.stringify({
    format: PI_TOOL_TRACE_FORMAT,
    headline: params.headline,
    sections: [
      {
        label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS,
        body: "Trace content was too large to serialize safely.",
        lang: null,
      },
    ],
  })
}

function safeToolArgumentSummary(event: ToolCallEvent): string {
  const input = "input" in event ? event.input : undefined
  const toolName = safeToolName(event.toolName)
  if (event.toolName === "bash") return "Shell command omitted for safety."
  if ((event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") && isObject(input)) {
    const action = event.toolName === "read" ? "Read" : event.toolName === "write" ? "Write" : "Edit"
    return `${action} target: ${"path" in input ? safeFileSummary(input.path) : "file"}. File contents and patches omitted for safety.`
  }
  if (event.toolName === "grep" || event.toolName === "find") return "Search arguments omitted for safety."
  if (event.toolName === "ls") return "Directory listing arguments omitted for safety."
  return `Arguments for ${toolName} omitted for safety.`
}

function bashCommand(event: ToolCallEvent): string | undefined {
  const input = "input" in event ? event.input : undefined
  if (event.toolName !== "bash" || !isObject(input) || typeof input.command !== "string") return undefined
  return input.command.trim() || undefined
}

function truncateCommandForTrace(command: string): string {
  if (command.length <= COMMAND_TRACE_MAX_CHARS) return command
  const marker = "\n\n…[trace content truncated]"
  return `${command.slice(0, COMMAND_TRACE_MAX_CHARS - marker.length).trimEnd()}${marker}`
}

function commandHeadline(command: string, fallback: string): string {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const firstLine = lines[0]?.replace(/\s+/g, " ")
  if (!firstLine) return fallback
  const extraLines = lines.length - 1
  const suffix = extraLines > 0 ? ` (+${extraLines} ${extraLines === 1 ? "line" : "lines"})` : ""
  const prefix = "Running "
  const available = COMMAND_HEADLINE_MAX_CHARS - prefix.length - suffix.length
  const summary =
    firstLine.length <= available ? firstLine : `${firstLine.slice(0, Math.max(0, available - 1)).trimEnd()}…`
  return `${prefix}${summary}${suffix}`
}

function toolTraceHeadline(event: ToolCallEvent, mode: ToolTraceMode): string {
  const fallback = describeToolCall(event).replace(/…$/, "")
  const command = mode === "commands" ? bashCommand(event) : undefined
  return command ? commandHeadline(command, fallback) : fallback
}

function commandToolArgumentSummary(event: ToolCallEvent): {
  label: PiToolTraceSectionLabel
  body: string
  lang: string | null
} {
  const command = bashCommand(event)
  if (!command) {
    return { label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS, body: safeToolArgumentSummary(event), lang: null }
  }
  // Plaintext Arguments sections are hard-redacted by the API. Details is the
  // bounded, regex-scrubbed lane for an explicitly enabled command trace.
  return {
    label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS,
    body: truncateCommandForTrace(command),
    lang: "bash",
  }
}

/**
 * The real tool arguments, for a sealed (E2EE) trace: the actual shell command,
 * the actual file path + contents/patch. Only ever serialized into sealed step
 * content. Plaintext turns use the headline or command-only paths above.
 */
function fullToolArgumentSummary(event: ToolCallEvent): { body: string; lang: string | null } {
  const input = "input" in event ? event.input : undefined
  if (event.toolName === "bash" && isObject(input) && typeof input.command === "string") {
    return { body: input.command, lang: "bash" }
  }
  if (input === undefined) return { body: "(no arguments)", lang: null }
  if (typeof input === "string") return { body: input, lang: null }
  try {
    return { body: JSON.stringify(input, null, 2), lang: "json" }
  } catch {
    return { body: String(input), lang: null }
  }
}

/**
 * Whether this invocation's trace should carry FULL tool detail. True only when
 * the turn is sealed (content is ciphertext to the server) AND the user hasn't
 * opted sealed traces out of full detail via `sealedFullTrace: false`. Formatters
 * default to `headline`, so a missed call site fails safe. The toggle can never
 * turn full detail on for a plaintext turn.
 */
function shouldEmitFullTrace(invocation: ClaimedInvocation | undefined): boolean {
  return invocation?.sealing !== undefined && config?.sealedFullTrace !== false
}

function traceModeForInvocation(invocation: ClaimedInvocation | undefined): ToolTraceMode {
  if (shouldEmitFullTrace(invocation)) return "full"
  return config?.traceMode === "commands" ? "commands" : "headline"
}

function formatToolCallTrace(event: ToolCallEvent, mode: ToolTraceMode = "headline"): string {
  const detail =
    mode === "full"
      ? { label: PI_TOOL_TRACE_SECTION_LABELS.ARGUMENTS, ...fullToolArgumentSummary(event) }
      : mode === "commands"
        ? commandToolArgumentSummary(event)
        : { label: PI_TOOL_TRACE_SECTION_LABELS.DETAILS, body: safeToolArgumentSummary(event), lang: null }
  return formatStructuredToolTrace({
    headline: toolTraceHeadline(event, mode),
    sections: [detail],
    ...(mode === "full" ? { maxChars: SEALED_TRACE_CONTENT_MAX_CHARS } : {}),
  })
}

function summarizeToolOutput(output: string): string {
  const text = output.trim()
  if (!text) return "Tool produced no textual output."
  const lines = text.split("\n").length
  return `Tool output omitted for safety. Captured locally: ${text.length} characters across ${lines} ${lines === 1 ? "line" : "lines"}.`
}

function formatToolResultTrace(
  event: ToolResultEvent,
  mode: ToolTraceMode = "headline",
  toolCalls: ReadonlyMap<string, { headline: string }> = new Map()
): string {
  const call = toolCalls.get(event.toolCallId)
  const output = textFromToolContent(event.content)
  const sections: Array<{ label: PiToolTraceSectionLabel; body: string; lang: string | null }> = []
  if (mode === "full") {
    sections.push({
      label: event.isError ? PI_TOOL_TRACE_SECTION_LABELS.ERROR_OUTPUT : PI_TOOL_TRACE_SECTION_LABELS.OUTPUT,
      body: output.trim() || "Tool produced no textual output.",
      lang: null,
    })
  } else {
    sections.push({
      label: event.isError ? PI_TOOL_TRACE_SECTION_LABELS.ERROR_OUTPUT : PI_TOOL_TRACE_SECTION_LABELS.OUTPUT,
      body: event.isError
        ? `${summarizeToolOutput(output)} Error details omitted for safety.`
        : summarizeToolOutput(output),
      lang: null,
    })
  }
  return formatStructuredToolTrace({
    headline: call?.headline ?? `Used ${safeToolName(event.toolName)}`,
    sections,
    ...(mode === "full" ? { maxChars: SEALED_TRACE_CONTENT_MAX_CHARS } : {}),
  })
}

function sanitizeTraceText(text: string): string {
  return text
    .replace(/, downloaded to [^)\n]+/g, "")
    .replace(/^THREA_ATTACH:\s*.+$/gm, "THREA_ATTACH: [local path omitted]")
}

function formatInvocationTrace(invocation: ClaimedInvocation, context: string): string {
  return truncateForTrace(
    sanitizeTraceText(
      [
        `Remote Threa invocation ${invocation.id}`,
        `Source message: ${invocation.sourceMessageId}`,
        "",
        "Prompt:",
        invocation.promptMarkdown,
        context ? ["", context].join("\n") : "",
      ]
        .filter(Boolean)
        .join("\n")
    )
  )
}

// Legacy default that older configTemplate versions baked into the JSON the
// user pasted during /configure. Treated as "unset" so it no longer collapses
// every scratchpad onto a single name across repos.
const LEGACY_DEFAULT_DISPLAY_NAME = "Local Pi"

function defaultDisplayNameFor(cwd: string, configuredOverride?: string): string {
  // The dirname tail is what makes the scratchpad distinguishable across
  // repos — without it, every Pi runtime on the same workspace produces a
  // scratchpad named "Pi remote" (or, worse, "Local Pi") and they're
  // impossible to tell apart in the sidebar. So always append it.
  //
  // `configuredOverride` (set during /configure) is treated as a *prefix*
  // when present, not a full replacement. Empty/whitespace and the legacy
  // "Local Pi" default fall back to "Pi remote" so existing configs do not
  // keep producing the bad name.
  const trimmed = configuredOverride?.trim() ?? ""
  const prefix = trimmed.length === 0 || trimmed === LEGACY_DEFAULT_DISPLAY_NAME ? "Pi remote" : trimmed
  const dir = cwd.split("/").filter(Boolean).pop() ?? "session"
  return `${prefix} - ${dir}`
}

/**
 * The owner-key half of an E2E session create. Throws with an actionable
 * message when the owner has no encryption key or this install has no BIK —
 * the /remote-control command surfaces it directly to the user.
 */
async function resolveE2eCreateBlock(): Promise<{ ownerKeyId: string; ownerPublicKey: string }> {
  if (!config) throw new Error("Threa remote config not loaded")
  const bik = await bikKeystore.ensure()
  if (!bik) throw new Error("e2e is enabled but this install could not create a bot identity key (see stderr)")
  try {
    const body = await request<{ data: { keyId: string; publicKey: string } }>(
      `/api/v1/workspaces/${config.workspaceId}/bot-runtime/owner-e2e-key`
    )
    return { ownerKeyId: body.data.keyId, ownerPublicKey: body.data.publicKey }
  } catch (error) {
    if (String(error).includes("404")) {
      throw new Error(
        "e2e is enabled but the bot owner has not set up encryption in Threa yet — set an encryption passphrase in the app first."
      )
    }
    throw error
  }
}

/**
 * Phase two of an encrypted create: mint the generation-0 stream key, wrap it
 * to the owner's UIK + this install's BIK, and store the wraps. Until this
 * lands nobody can seal into the scratchpad; a 409 means an earlier attempt
 * already provisioned it.
 */
async function provisionE2eStreamKey(
  rootStreamId: string,
  e2e: { ownerKeyId: string; ownerPublicKey: string }
): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  const bik = await bikKeystore.ensure()
  if (!bik) throw new Error("BIK unavailable for provisioning")
  const { wraps } = await mintStreamKeyWraps({
    streamId: rootStreamId,
    keyGeneration: 0,
    recipients: [
      { recipientKind: "user", recipientKeyId: e2e.ownerKeyId, publicKeyBase64: e2e.ownerPublicKey },
      { recipientKind: "bot", recipientKeyId: bik.publicKeyId, publicKeyBase64: bik.publicKeyBase64 },
    ],
  })
  for (let attempt = 1; ; attempt++) {
    try {
      await request(`/api/v1/workspaces/${config.workspaceId}/streams/${rootStreamId}/e2e/key-wraps`, {
        method: "POST",
        body: JSON.stringify({ keyGeneration: 0, wraps }),
      })
      return
    } catch (error) {
      if (String(error).includes("409")) return
      if (attempt >= 3) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
    }
  }
}

async function createRemoteSession(ctx: ExtensionCommandContext, args: string): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  if (process.env.THREA_EXPECTED_ROOT_STREAM_ID) {
    throw new Error("Supervised revival cannot create or relink a Pi scratchpad")
  }
  const runtimeSessionId = getRuntimeSessionId(ctx)
  const instanceId = instanceIdForRemoteCreate(runtimeSessionId)
  const displayName = args.trim() || defaultDisplayNameFor(ctx.cwd, config.defaultDisplayName)
  const e2e = config.e2e ? await resolveE2eCreateBlock() : undefined

  const body = await request<{ data: RuntimeSessionLink }>(
    `/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        runtimeKind: "pi-local",
        instanceId,
        runtimeSessionId,
        displayName,
        localCwd: ctx.cwd,
        ...(config.defaultLabel && { labelName: config.defaultLabel }),
        ...(e2e ? { e2e: { ownerKeyId: e2e.ownerKeyId } } : {}),
      }),
    }
  )

  if (e2e && body.data.e2eEnabled === true) {
    await provisionE2eStreamKey(body.data.rootStreamId, e2e)
  } else if (e2e) {
    ctx.ui.notify(
      "This session resumed an existing plaintext scratchpad; archive it to get an encrypted one on the next link.",
      "warning"
    )
  }

  const existing = config.linkedSessions?.[runtimeSessionId]
  const legacyCursor =
    config.streamCursors?.[body.data.activeStreamId] ?? config.streamCursors?.[body.data.rootStreamId]
  config.linkedSessions ??= {}
  config.linkedSessions[runtimeSessionId] = {
    ...body.data,
    instanceId,
    enabled: true,
    streamCursors: existing?.streamCursors ?? (legacyCursor ? { [body.data.activeStreamId]: legacyCursor } : undefined),
  }
  saveConfig()

  syncHarnessLink(ctx)
  ctx.ui.notify(`Threa remote linked: ${body.data.streamUrlPath}`, "info")
  setRemoteStatus(ctx, `Threa remote: ${displayName}`)
  await heartbeat("available", undefined, ctx)
}

async function verifySupervisedRevival(ctx: ExtensionContext): Promise<boolean> {
  const expectedRootStreamId = process.env.THREA_EXPECTED_ROOT_STREAM_ID?.trim()
  if (!expectedRootStreamId) {
    supervisedRevivalBlocked = false
    return true
  }
  if (!config) {
    supervisedRevivalBlocked = true
    return false
  }
  const link = getCurrentSessionLink(ctx)
  if (!link || link.rootStreamId !== expectedRootStreamId) {
    supervisedRevivalBlocked = true
    ctx.ui.notify("Threa revival blocked: the local Pi session points at a different scratchpad.", "error")
    return false
  }
  try {
    const body = await request<{ data: RuntimeSessionLink }>(
      `/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          runtimeKind: "pi-local",
          instanceId: getSessionInstanceId(ctx),
          runtimeSessionId: getRuntimeSessionId(ctx),
          displayName: defaultDisplayNameFor(ctx.cwd, config.defaultDisplayName),
          localCwd: ctx.cwd,
          ifArchived: "wait",
          ifMissing: "error",
        }),
      }
    )
    if (body.data.rootStreamId !== expectedRootStreamId) {
      supervisedRevivalBlocked = true
      ctx.ui.notify("Threa revival blocked: the server session points at a different scratchpad.", "error")
      return false
    }
    supervisedRevivalBlocked = false
    return true
  } catch (error) {
    supervisedRevivalBlocked = true
    ctx.ui.notify(`Threa revival blocked: ${summarizeError(error)}`, "error")
    return false
  }
}

async function renameRemoteSession(ctx: ExtensionCommandContext, displayName: string): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  const link = getCurrentSessionLink(ctx)
  if (!link) {
    ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
    return
  }
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions/rename`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: getSessionInstanceId(ctx),
      runtimeSessionId: getRuntimeSessionId(ctx),
      displayName,
    }),
  })
  ctx.ui.notify(`Threa remote renamed to "${displayName}"`, "info")
  setRemoteStatus(ctx, `Threa remote: ${displayName}`)
}

async function rebindLegacySessionInstance(ctx: ExtensionContext): Promise<void> {
  if (!config) return
  const link = getCurrentSessionLink(ctx)
  if (!link || link.instanceId) return
  const oldInstanceId = ensureInstanceId()
  const newInstanceId = createInstanceId()
  await request<{ data: RuntimeSessionLink }>(`/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions/rebind`, {
    method: "POST",
    body: JSON.stringify({
      linkId: link.linkId,
      instanceId: oldInstanceId,
      runtimeSessionId: getRuntimeSessionId(ctx),
      newInstanceId,
    }),
  })
  link.instanceId = newInstanceId
  saveConfig()
}

async function tryRebindLegacySessionInstance(ctx: ExtensionContext): Promise<void> {
  try {
    await rebindLegacySessionInstance(ctx)
  } catch (error) {
    emitPollDebug(ctx, `legacy session rebind failed: ${summarizeError(error)}`)
    ctx.ui.notify(
      `Threa remote is using a legacy shared instance id; connected status can be wrong when multiple Pi sessions run. ${summarizeError(error)}`,
      "warning"
    )
  }
}

function releaseObservation(invocation: ClaimedInvocation): void {
  const observed = observedInvocations.get(invocation)
  if (!observed) return
  observed.state = "terminal"
  observedInvocations.delete(invocation)
  observed.handle.unregister()
}

function isInvocationWriteCurrent(
  invocation: ClaimedInvocation,
  revision: number,
  expectedObserved: ObservedInvocationContext | null
): boolean {
  const currentObserved = observedInvocations.get(invocation)
  return (
    !cancelledInvocations.has(invocation) &&
    invocation.sourceRevision === revision &&
    (expectedObserved
      ? currentObserved === expectedObserved &&
        expectedObserved.state !== "terminal" &&
        !expectedObserved.restartRequested
      : currentObserved === undefined)
  )
}

function releaseAllObservations(): void {
  for (const invocation of [...observedInvocations.keys()]) releaseObservation(invocation)
}

function clearContributorTerminalWrites(): void {
  for (const owner of contributorTerminalWrites.values()) {
    if (owner.timer) clearTimeout(owner.timer)
  }
  contributorTerminalWrites.clear()
}

function clearTurnState(ctx?: ExtensionContext): void {
  clearContributorTerminalWrites()
  primaryCompletionCommitted = false
  pending = undefined
  steeredInvocations = []
  pendingContextCursor = undefined
  pendingInvocationPrompt = undefined
  clearPendingRetry()
  isWaitingForRetry = false
  carryOnTexts = []
  lastTraceHeartbeat = undefined
  clearRecoveredCompletionTimer()
  awaitingTurnStart = false
  activeOutputState = undefined
  if (ctx) clearPendingSnapshot(ctx)
}

function scheduleClaimDrain(pi: ExtensionAPI, ctx: ExtensionContext): void {
  setTimeout(() => void claimIfIdle(pi, ctx).catch(() => undefined), 0)
}

function cancelObservedTurn(target: ClaimedInvocation, pi: ExtensionAPI, ctx: ExtensionContext): void {
  const observed = observedInvocations.get(target)
  if (!observed || (observed.state === "terminal" && cancelledInvocations.has(target))) return
  const wasTerminalizing = observed.state === "terminalizing"
  cancelledInvocations.add(target)
  observed.state = "terminal"
  const terminalWrite = contributorTerminalWrites.get(target)
  if (terminalWrite?.timer) clearTimeout(terminalWrite.timer)
  contributorTerminalWrites.delete(target)
  // The provider result is already durably posted once contributor closure
  // begins. A late contributor cancellation closes only that terminal lag; it
  // must not tear down the committed primary or discard sibling close owners.
  if (wasTerminalizing && primaryCompletionCommitted) {
    releaseObservation(target)
    void maybeFinalizeCommittedTurn(ctx)
    return
  }
  const contributors = [pending, ...steeredInvocations.map((item) => item.invocation)].filter(
    (item): item is ClaimedInvocation => item !== undefined
  )
  const ownsCombinedTurn = contributors.includes(target)
  const ownsControlTurn = activeControlInvocation === target
  if (ownsControlTurn) activeControlInvocation = undefined
  const otherContributors = ownsCombinedTurn
    ? contributors.filter((invocation) => invocation !== target && !cancelledInvocations.has(invocation))
    : []
  if (ownsCombinedTurn) {
    cancelPendingRetryTimer()
    clearRecoveredCompletionTimer()
    resetPendingTurnTexts()
    if (!observed.abortIssued && !ctx.isIdle()) {
      observed.abortIssued = true
      ctx.abort()
    }
    for (const invocation of contributors) releaseObservation(invocation)
    clearTurnState(ctx)
    void Promise.all(
      otherContributors.map((invocation) =>
        failInvocation(invocation, "Combined Pi turn cancelled because one contributing invocation ended")
      )
    )
  } else {
    // A standalone control or not-yet-delivered claim owns no provider output.
    // Its cancellation must not stop/release an unrelated retrying turn.
    if (ownsControlTurn && !observed.abortIssued && !ctx.isIdle()) {
      observed.abortIssued = true
      ctx.abort()
    }
    releaseObservation(target)
  }
  scheduleClaimDrain(pi, ctx)
}

function abortForInputRestart(observed: ObservedInvocationContext, reason: string): void {
  const invocation = observed.invocation
  const contributors = [pending, ...steeredInvocations.map((item) => item.invocation)].filter(
    (item): item is ClaimedInvocation => item !== undefined
  )
  // A claim being prepared (notably a standalone session-control command
  // claimed during a provider retry wait) has not contributed input to the Pi
  // turn yet. Restart only that claim; clearing the combined turn here would
  // discard unrelated canonical retry/carry-on state.
  if (!contributors.includes(invocation)) return
  const otherContributors = contributors.filter((contributor) => contributor !== invocation)
  for (const contributor of otherContributors) releaseObservation(contributor)
  if (!observed.abortIssued && !observed.ctx.isIdle()) {
    observed.abortIssued = true
    observed.ctx.abort()
  }
  clearTurnState(observed.ctx)
  void Promise.all(otherContributors.map((contributor) => failInvocation(contributor, reason)))
}

function installUpdatedCommandMetadata(invocation: ClaimedInvocation, promptMarkdown: string): boolean {
  const command = getRuntimeCommand(invocation)
  if (!command) return true
  const parsed = parseSessionControlCommand(promptMarkdown)
  if (!parsed) return false
  invocation.metadata = {
    ...invocation.metadata,
    command: { ...command, name: parsed.name, args: parsed.args },
  }
  return true
}

async function applyInvocationUpdate(
  observed: ObservedInvocationContext,
  update: InvocationInputUpdate,
  signal: AbortSignal = new AbortController().signal
): Promise<"applied" | "restart-required"> {
  const invocation = observed.invocation
  const fenceAbortedUpdate = () => cancelObservedTurn(invocation, observed.pi, observed.ctx)
  if (signal.aborted) {
    fenceAbortedUpdate()
    return "restart-required"
  }
  if (observed.state === "terminal" || cancelledInvocations.has(invocation)) return "restart-required"
  if (!installUpdatedCommandMetadata(invocation, update.promptMarkdown)) {
    observed.restartRequested = true
    abortForInputRestart(observed, "Combined Pi turn restarted after session-control input changed shape")
    return "restart-required"
  }
  if (observed.state === "processing" || observed.state === "recovery") {
    observed.restartRequested = true
    abortForInputRestart(observed, "Combined Pi turn restarted after an input preparation race")
    return "restart-required"
  }
  signal.addEventListener("abort", fenceAbortedUpdate, { once: true })
  if (signal.aborted) {
    fenceAbortedUpdate()
    signal.removeEventListener("abort", fenceAbortedUpdate)
    return "restart-required"
  }
  observed.updateInProgress = true
  invocation.sourceRevision = update.sourceRevision
  invocation.promptMarkdown = update.promptMarkdown
  if (update.sealing) invocation.sealing = update.sealing
  if (update.delivery === "sealed") invocation.sealedSourceAttachmentRefs = update.attachmentRefs
  try {
    throwIfAborted(signal)
    if (observed.state === "terminalizing") return "applied"
    // Initial synchronization only installs canonical metadata. Attachment I/O
    // happens once, after sync, in prepareSealedClaim; doing it here would make
    // the authoritative handshake wait on stale local file work.
    if (observed.state === "unstarted") return "applied"
    armPendingOutput()
    if (update.delivery === "sealed") {
      const attachmentLines = await downloadSealedContextAttachments(
        update.attachmentRefs,
        [],
        invocation,
        observed.ctx.cwd,
        signal
      )
      throwIfAborted(signal)
      applySealedAttachmentContext(invocation, attachmentLines)
    }
    throwIfAborted(signal)
    if (cancelledInvocations.has(invocation) || observedInvocations.get(invocation) !== observed)
      return "restart-required"
    const updatedCommand = getRuntimeCommand(invocation)
    const rebuilt = await buildInvocationPrompt(
      invocation,
      observed.ctx,
      true,
      updatedCommand?.name === "steer" ? updatedCommand.args : undefined,
      signal
    )
    throwIfAborted(signal)
    if (
      cancelledInvocations.has(invocation) ||
      observedInvocations.get(invocation) !== observed ||
      invocation.sourceRevision !== update.sourceRevision
    ) {
      return "restart-required"
    }
    const secondary = steeredInvocations.find((item) => item.invocation === invocation)
    if (secondary) secondary.retryPrompt = rebuilt.steerPrompt
    else pendingInvocationPrompt = rebuilt.prompt
    if (isWaitingForRetry) return "applied"
    throwIfAborted(signal)
    if (observedInvocations.get(invocation) !== observed) return "restart-required"
    observed.pi.sendUserMessage(rebuilt.steerPrompt, { deliverAs: "steer" })
    observed.state = "running"
    return "applied"
  } catch {
    if (!signal.aborted && observedInvocations.get(invocation) === observed) {
      observed.restartRequested = true
      abortForInputRestart(observed, "Combined Pi turn restarted after input steering failed")
    }
    return "restart-required"
  } finally {
    signal.removeEventListener("abort", fenceAbortedUpdate)
    observed.updateInProgress = false
  }
}

async function observeInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation,
  initialState: ObservedInvocationState = "unstarted"
): Promise<boolean> {
  const activeTransport = ensureTransport(pi, ctx)
  if (!activeTransport) return false
  const identity = invocation.sealedIdentity
  let observed!: ObservedInvocationContext
  const handle = activeTransport.observeClaim({
    invocationId: invocation.id,
    claimToken: invocation.claimToken,
    sourceRevision: invocation.sourceRevision,
    claimTtlSeconds: CLAIM_TTL_SECONDS,
    instanceId: getInvocationInstanceId(invocation),
    callbacks: {
      onInputUpdated: (update, signal) => applyInvocationUpdate(observed, update, signal),
      onCancelled: () => cancelObservedTurn(invocation, pi, ctx),
      onClaimLost: () => cancelObservedTurn(invocation, pi, ctx),
    },
    ...(invocation.sealing && identity
      ? {
          sealed: {
            identity,
            streamId: invocation.rootStreamId ?? invocation.activeStreamId,
            callbackToken: invocation.sealing.callbackToken,
          },
        }
      : {}),
  })
  observed = {
    invocation,
    handle,
    state: initialState,
    updateInProgress: false,
    restartRequested: false,
    abortIssued: false,
    ctx,
    pi,
  }
  observedInvocations.set(invocation, observed)
  await handle.sync()
  return observedInvocations.get(invocation) === observed && observed.state !== "terminal"
}

type PendingTurnSnapshot = {
  version: 1
  savedAt: number
  runtimeSessionId: string
  workspaceId: string
  instanceId: string
  rootStreamId?: string
  invocation: Record<string, unknown>
  steered: Array<{ invocation: Record<string, unknown>; cursor?: string; retryPrompt?: string }>
  contextCursor?: string
  invocationPrompt?: string
  primaryCompleted?: boolean
  waitingForRetry?: { retryAt: number; attempts: number; carryOnTexts: string[] }
}

function pendingSnapshotPath(runtimeSessionId: string): string {
  return join(PENDING_SNAPSHOT_DIRECTORY, `threa-remote-pending-${runtimeSessionId}.json`)
}

function serializeInvocationForSnapshot(invocation: ClaimedInvocation): Record<string, unknown> {
  const { sealing, sealedIdentity: _sealedIdentity, ...rest } = invocation
  if (!sealing) return rest
  return {
    ...rest,
    sealing: {
      ...sealing,
      replySsk: bytesToBase64(sealing.replySsk),
    },
  }
}

function deserializeInvocationFromSnapshot(value: unknown): ClaimedInvocation | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.activeStreamId !== "string" ||
    typeof candidate.sourceMessageId !== "string" ||
    !Number.isInteger(candidate.sourceRevision) ||
    (candidate.sourceRevision as number) < 0 ||
    typeof candidate.promptMarkdown !== "string" ||
    typeof candidate.claimToken !== "string"
  ) {
    return undefined
  }
  const invocation = { ...candidate } as unknown as ClaimedInvocation
  if (candidate.sealing !== undefined) {
    if (!candidate.sealing || typeof candidate.sealing !== "object") return undefined
    const sealing = candidate.sealing as Record<string, unknown>
    if (
      typeof sealing.streamId !== "string" ||
      typeof sealing.replyKeyGeneration !== "number" ||
      typeof sealing.replySenderId !== "string" ||
      typeof sealing.callbackToken !== "string" ||
      typeof sealing.replySsk !== "string"
    ) {
      return undefined
    }
    invocation.sealing = {
      streamId: sealing.streamId,
      replyKeyGeneration: sealing.replyKeyGeneration,
      replySenderId: sealing.replySenderId,
      callbackToken: sealing.callbackToken,
      replySsk: base64ToBytes(sealing.replySsk),
    }
  }
  return invocation
}

function savePendingSnapshot(ctx: ExtensionContext): void {
  if (!pending) return
  const runtimeSessionId = getRuntimeSessionId(ctx)
  const link = getCurrentSessionLink(ctx)
  const snapshot: PendingTurnSnapshot = {
    version: 1,
    savedAt: Date.now(),
    runtimeSessionId,
    workspaceId: config?.workspaceId ?? "",
    instanceId: getInvocationInstanceId(pending),
    ...(link?.rootStreamId ? { rootStreamId: link.rootStreamId } : {}),
    invocation: serializeInvocationForSnapshot(pending),
    steered: steeredInvocations.map((item) => ({
      invocation: serializeInvocationForSnapshot(item.invocation),
      ...(item.cursor ? { cursor: item.cursor } : {}),
      retryPrompt: item.retryPrompt,
    })),
    ...(pendingContextCursor ? { contextCursor: pendingContextCursor } : {}),
    ...(pendingInvocationPrompt ? { invocationPrompt: pendingInvocationPrompt } : {}),
    ...(primaryCompletionCommitted ? { primaryCompleted: true } : {}),
    ...(isWaitingForRetry && pendingRetry
      ? {
          waitingForRetry: {
            retryAt: pendingRetry.retryAt,
            attempts: pendingRetry.attempts,
            carryOnTexts: [...carryOnTexts],
          },
        }
      : {}),
  }
  try {
    mkdirSync(PENDING_SNAPSHOT_DIRECTORY, { recursive: true })
    const path = pendingSnapshotPath(runtimeSessionId)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    console.error(`Threa remote: pending snapshot save failed: ${summarizeError(error)}`)
  }
}

function clearPendingSnapshot(ctx: ExtensionContext): void {
  try {
    unlinkSync(pendingSnapshotPath(getRuntimeSessionId(ctx)))
  } catch {
    // Already absent.
  }
}

function readPendingSnapshot(ctx: ExtensionContext): PendingTurnSnapshot | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(pendingSnapshotPath(getRuntimeSessionId(ctx)), "utf8"))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const snapshot = parsed as Partial<PendingTurnSnapshot>
  const link = getCurrentSessionLink(ctx)
  if (
    snapshot.version !== 1 ||
    typeof snapshot.savedAt !== "number" ||
    Date.now() - snapshot.savedAt > CLAIM_TTL_SECONDS * 1000 ||
    snapshot.runtimeSessionId !== getRuntimeSessionId(ctx) ||
    snapshot.workspaceId !== config?.workspaceId ||
    snapshot.rootStreamId !== link?.rootStreamId ||
    !snapshot.invocation ||
    !Array.isArray(snapshot.steered)
  ) {
    return undefined
  }
  return snapshot as PendingTurnSnapshot
}

function recoverFinalTextFromBranch(ctx: ExtensionContext): string | undefined {
  const messages: Array<{ role: string; text: string }> = []
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue
    const role = String(entry.message.role)
    if (role !== "user" && role !== "assistant") continue
    const text = textFromContent(entry.message.content).trim()
    if (text) messages.push({ role, text })
  }
  let anchor = -1
  if (pendingInvocationPrompt) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user" && messages[i]?.text === pendingInvocationPrompt) {
        anchor = i
        break
      }
    }
  }
  if (anchor < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        anchor = i
        break
      }
    }
  }
  if (anchor < 0) return undefined
  return messages
    .slice(anchor + 1)
    .filter((message) => message.role === "assistant")
    .at(-1)?.text
}

function clearRecoveredCompletionTimer(): void {
  if (!recoveredCompletionTimer) return
  clearTimeout(recoveredCompletionTimer)
  recoveredCompletionTimer = undefined
}

function discardRestoredPending(ctx: ExtensionContext): void {
  releaseAllObservations()
  clearTurnState(ctx)
}

function scheduleRecoveredCompletion(finalText: string, ctx: ExtensionContext, delayMs = 0, attempt = 1): void {
  const lifecycleGeneration = sessionLifecycleGeneration
  clearRecoveredCompletionTimer()
  recoveredCompletionTimer = setTimeout(() => {
    recoveredCompletionTimer = undefined
    if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration || !pending) return
    const settlement = (async () => {
      try {
        await completePending(finalText, ctx)
      } catch (error) {
        if (
          error instanceof ThreaApiError &&
          (error.status === 404 || (error.status === 409 && error.code === "INVOCATION_INPUT_STALE"))
        ) {
          discardRestoredPending(ctx)
          return
        }
        const permanentClientError = error instanceof ThreaApiError && error.status >= 400 && error.status < 500
        const hasAttachments = extractAttachmentDirectives(finalText).paths.length > 0
        if (permanentClientError || hasAttachments) {
          try {
            await failPending(`Recovered completion failed: ${summarizeError(error)}`, ctx)
          } catch {
            discardRestoredPending(ctx)
          }
          return
        }
        scheduleRecoveredCompletion(finalText, ctx, Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)), attempt + 1)
      }
    })()
    pendingSettlement = settlement
    void settlement.finally(() => {
      if (pendingSettlement === settlement) pendingSettlement = undefined
    })
  }, delayMs)
}

async function restorePendingAfterReload(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const snapshot = readPendingSnapshot(ctx)
  if (!snapshot) {
    clearPendingSnapshot(ctx)
    return
  }
  const invocation = deserializeInvocationFromSnapshot(snapshot.invocation)
  if (!invocation || snapshot.instanceId !== getInvocationInstanceId(invocation)) {
    clearPendingSnapshot(ctx)
    return
  }
  const restoredSteers = snapshot.steered.flatMap((item) => {
    const restored = deserializeInvocationFromSnapshot(item.invocation)
    return restored
      ? [{ invocation: restored, cursor: item.cursor, retryPrompt: item.retryPrompt ?? restored.promptMarkdown }]
      : []
  })
  await Promise.all(
    [invocation, ...restoredSteers.map((item) => item.invocation)].map(async (restored) => {
      if (restored.sealing) restored.sealedIdentity = (await bikKeystore.ensure()) ?? undefined
    })
  )
  pending = invocation
  steeredInvocations = restoredSteers
  pendingContextCursor = typeof snapshot.contextCursor === "string" ? snapshot.contextCursor : undefined
  pendingInvocationPrompt = typeof snapshot.invocationPrompt === "string" ? snapshot.invocationPrompt : undefined
  primaryCompletionCommitted = snapshot.primaryCompleted === true
  if (primaryCompletionCommitted) {
    for (const item of restoredSteers) {
      if (!(await observeInvocation(pi, ctx, item.invocation, "terminalizing"))) {
        discardRestoredPending(ctx)
        return
      }
      if (pending !== invocation) return
    }
    savePendingSnapshot(ctx)
    await Promise.all(restoredSteers.map((item) => completeInvocationNoResponse(item.invocation, ctx)))
    await maybeFinalizeCommittedTurn(ctx)
    return
  }
  armPendingOutput()
  const restoreEpoch = promptEpoch
  const waiting = snapshot.waitingForRetry
  if (waiting && typeof waiting.retryAt === "number") {
    isWaitingForRetry = true
    carryOnTexts = Array.isArray(waiting.carryOnTexts)
      ? waiting.carryOnTexts.filter((text): text is string => typeof text === "string")
      : []
  }
  // A combined turn is recovered conservatively: no contributor may steer
  // before every sibling has synchronized. Any missed edit requests a clean
  // restart, while a completely clean set transitions to running together.
  const recoveredState: ObservedInvocationState =
    restoredSteers.length > 0 || (!waiting && ctx.isIdle()) ? "recovery" : "running"
  if (!(await observeInvocation(pi, ctx, invocation, recoveredState))) {
    discardRestoredPending(ctx)
    return
  }
  if (pending !== invocation) return
  for (const item of restoredSteers) {
    if (!(await observeInvocation(pi, ctx, item.invocation, recoveredState))) {
      discardRestoredPending(ctx)
      return
    }
    if (pending !== invocation) return
  }
  const restoredObserved = [invocation, ...restoredSteers.map((item) => item.invocation)].map((item) =>
    observedInvocations.get(item)
  )
  if (restoredObserved.some((item) => !item || item.state === "terminal" || item.restartRequested)) return
  for (const item of restoredObserved) if (item?.state === "recovery") item.state = "running"
  await recordTraceStep(
    "context_received",
    "Pi reloaded its extensions; resuming the in-flight invocation.",
    "Resumed after reload…"
  ).catch(() => undefined)

  // A hot extension reload can happen in the middle of an already-started Pi
  // turn, in which case no new turn_start follows. Bind that cleanly recovered
  // output now. A sync-time edit advanced the epoch and queued a steer, so it
  // deliberately remains behind the next real turn_start barrier.
  if (!waiting && !ctx.isIdle() && promptEpoch === restoreEpoch) activatePendingOutput()

  if (waiting && typeof waiting.retryAt === "number") {
    const attempts = typeof waiting.attempts === "number" ? waiting.attempts : 1
    const retryAt = Math.max(Date.now(), waiting.retryAt)
    const lifecycleGeneration = sessionLifecycleGeneration
    pendingRetry = {
      timer: setTimeout(
        () => void executeProviderRetry(pi, ctx, attempts, lifecycleGeneration).catch(() => undefined),
        retryAt - Date.now()
      ),
      retryAt,
      attempts,
    }
    setRemoteStatus(ctx, `Threa remote: retry ${formatLocalTime(new Date(retryAt))}`)
    return
  }

  if (ctx.isIdle()) {
    const finalText = recoverFinalTextFromBranch(ctx)
    if (finalText) scheduleRecoveredCompletion(finalText, ctx)
    else await failPending("Pi reloaded as the turn finished; the final response could not be recovered.", ctx)
    return
  }
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
}

function isEnabled(ctx: ExtensionContext): boolean {
  return !supervisedRevivalBlocked && isCurrentSessionEnabled(ctx)
}

function shouldHandleSessionEvents(ctx: ExtensionContext): boolean {
  return isEnabled(ctx)
}

function stopPolling(): void {
  pollingRunId += 1
  if (timer) clearTimeout(timer)
  timer = undefined
  rearmPoll = undefined
  // Release the worker latch: a poll still awaiting something from BEFORE this
  // stop (a reload tears polling down mid-flight) must not make every tick of
  // the NEXT loop skip as "in flight" until that orphan settles. Its own
  // finally guards on run id, so this reset cannot be double-cleared.
  pollInFlightRunId = undefined
}

/**
 * The controller for this Pi session. Hooks carry the Pi-specific effects; the
 * pending state, deadline, probe guard and post-await identity checks live in
 * the shared machine.
 */
function ensureArchiveController(ctx: ExtensionContext): ArchiveGraceController {
  archive ??= new ArchiveGraceController(
    {
      isArchived: async (rootStreamId) => {
        if (!config) return undefined
        const body = await request<{ data: { archivedAt?: string | null } }>(
          `/api/v1/workspaces/${config.workspaceId}/streams/${rootStreamId}`
        )
        return Boolean(body.data?.archivedAt)
      },
      reattach: async (rootStreamId) => {
        if (!config) return false
        const body = await request<{ data: RuntimeSessionLink }>(
          `/api/v1/workspaces/${config.workspaceId}/bot-runtime/sessions`,
          {
            method: "POST",
            body: JSON.stringify({
              runtimeKind: "pi-local",
              instanceId: getSessionInstanceId(ctx),
              runtimeSessionId: getRuntimeSessionId(ctx),
              displayName: defaultDisplayNameFor(ctx.cwd, config.defaultDisplayName),
              localCwd: ctx.cwd,
              ifArchived: "wait",
              ifMissing: "error",
            }),
          }
        )
        return body.data.rootStreamId === rootStreamId
      },
      onDetached: async (_rootStreamId, graceMs) => {
        // An in-flight poll re-arms at the probe cadence from its own finally block.
        if (pollInFlightRunId === undefined) rearmPoll?.(ensureArchiveController(ctx).probeDelayMs)
        const minutes = Math.round(graceMs / 60_000)
        setRemoteStatus(ctx, `Threa remote: scratchpad archived; winding down in ${minutes}m`, "error")
        ctx.ui.notify(
          `Threa scratchpad archived. Unarchive within ${minutes} minutes to reattach; otherwise this branch is pushed and the worktree removed.`,
          "warning"
        )
        await heartbeat("offline", undefined, ctx).catch(() => undefined)
      },
      onReattached: async () => {
        setRemoteStatus(ctx, "Threa remote: linked")
        ctx.ui.notify("Threa scratchpad unarchived; reattached.", "info")
        await heartbeat("available", undefined, ctx).catch(() => undefined)
      },
      onWindDown: () => {
        // Marked, not cleared: harnessd preserves the branch and removes the
        // worktree under `resume-active.lock`, and it can only find this
        // worktree while the record is still there.
        markHarnessLinkWoundDown(getRuntimeSessionId(ctx))
        stopPolling()
        releaseAllObservations()
        teardownTransport()
        if (archiveKillWindow()) return
        ctx.ui.notify(
          "Threa scratchpad archived. This worktree is finished — close the window and harnessd will push the branch and remove it.",
          "warning"
        )
      },
      log: (message) => emitPollDebug(ctx, message),
    },
    archiveGraceMs === undefined ? {} : { graceMs: archiveGraceMs }
  )
  return archive
}

/**
 * Record what this window owns so harnessd can reap it later. Idempotent, and
 * refreshed from the poll tick as well as on link, because an archive that
 * lands while this process is dead has nothing else to go on.
 */
function syncHarnessLink(ctx: ExtensionContext): void {
  const link = getCurrentSessionLink(ctx)
  if (!config || !link?.rootStreamId) return
  recordHarnessLink({
    runtimeKind: "pi-local",
    runtimeSessionId: getRuntimeSessionId(ctx),
    instanceId: getSessionInstanceId(ctx),
    rootStreamId: link.rootStreamId,
    worktree: ctx.cwd,
  })
}

/** The poll-tick backstop: `bot:session_archived` is a one-shot push with no replay. */
async function probeArchiveState(ctx: ExtensionContext): Promise<void> {
  if (!config || sessionTearingDown) return
  syncHarnessLink(ctx)
  await ensureArchiveController(ctx).probe(getCurrentSessionLink(ctx)?.rootStreamId)
}

/**
 * Scoped to this runtime session AND the currently linked root: a cold start
 * replaces an archived scratchpad under the same deterministic identity, so a
 * delayed event for the retired root must not wind down the live one.
 */
function handleArchivePush(ctx: ExtensionContext, payload: unknown): void {
  if (!isObject(payload) || sessionTearingDown) return
  if (typeof payload.runtimeSessionId === "string" && payload.runtimeSessionId !== getRuntimeSessionId(ctx)) return
  const linked = getCurrentSessionLink(ctx)?.rootStreamId
  const rootStreamId = typeof payload.rootStreamId === "string" ? payload.rootStreamId : linked
  if (!rootStreamId || (linked && rootStreamId !== linked)) return
  void ensureArchiveController(ctx).archived(rootStreamId)
}

function handleRestorePush(ctx: ExtensionContext, payload: unknown): void {
  if (!isObject(payload) || sessionTearingDown) return
  if (typeof payload.runtimeSessionId === "string" && payload.runtimeSessionId !== getRuntimeSessionId(ctx)) return
  void ensureArchiveController(ctx).restored()
}

function handleTransportDisconnected(
  schedule: typeof rearmPoll = rearmPoll,
  inFlightRunId = pollInFlightRunId,
  activeRunId = pollingRunId
): void {
  if (sessionTearingDown) return
  consecutiveQuietPolls = 0
  if (inFlightRunId !== activeRunId) schedule?.(basePollMs())
}

function basePollMs(): number {
  // When the `/bot` socket is up the server pushes new work within a frame,
  // so the poll is just a safety net for the rare missed-emit case (plan §5).
  // Drop to a 30s backstop instead of the 3s spin we run without WS.
  if (transport?.socketConnected) return Math.max(WS_BACKSTOP_POLL_MS, config?.pollMs ?? WS_BACKSTOP_POLL_MS)
  return Math.max(1000, config?.pollMs ?? 3000)
}

function failurePollMs(): number {
  if (consecutivePollFailures <= 0) return basePollMs()
  return Math.min(MAX_FAILURE_POLL_MS, basePollMs() * 2 ** Math.min(consecutivePollFailures - 1, 8))
}

/**
 * Delay until the next poll tick, advancing the quiet-poll backoff. Socket up,
 * turn in flight, or a fresh claim → fast cadence (steer/stop and queued
 * follow-ups must stay responsive mid-turn). Idle AND socketless → double per
 * empty tick up to {@link NO_SOCKET_POLL_CAP_MS}, so a wedged session can't
 * burn the edge-request quota.
 */
function nextQuietPollMs(): number {
  // Detached-pending-restore: probe at a fixed cadence so a missed
  // bot:session_restored push still reattaches inside the grace window. The
  // window bounds the total probes, so this cannot become a quota burn.
  if (archive?.detached) return archive.probeDelayMs
  if (transport?.socketConnected || pending || steeredInvocations.length > 0) {
    consecutiveQuietPolls = 0
    return basePollMs()
  }
  const delay = Math.min(NO_SOCKET_POLL_CAP_MS, basePollMs() * 2 ** consecutiveQuietPolls)
  consecutiveQuietPolls = Math.min(consecutiveQuietPolls + 1, 8)
  return delay
}

function notePollSuccess(ctx: ExtensionContext): void {
  if (consecutivePollFailures === 0) return
  consecutivePollFailures = 0
  lastPollFailureSummary = undefined
  setRemoteStatus(ctx, pending ? `Threa remote: running ${pending.id}` : "Threa remote: linked")
}

function notePollFailure(ctx: ExtensionContext, error: unknown): void {
  consecutivePollFailures += 1
  const summary = summarizeError(error)
  const retrySeconds = Math.ceil(failurePollMs() / 1000)
  setRemoteStatus(ctx, `Threa remote: failed; retrying in ${retrySeconds}s`, "error")
  if (summary !== lastPollFailureSummary) {
    lastPollFailureSummary = summary
    ctx.ui.notify(`Threa remote connection failed; retrying in background. ${summary}`, "warning")
  }
}

function configTemplate(existing: Partial<Config> | undefined): string {
  return JSON.stringify(
    {
      baseUrl: existing?.baseUrl ?? "https://app.threa.io",
      workspaceId: existing?.workspaceId ?? "",
      apiKey: existing?.apiKey ?? "",
      pollMs: existing?.pollMs ?? 3000,
      // Empty default: `defaultDisplayNameFor` now always appends the dirname,
      // so leaving this blank produces "Pi remote - <project>". Users who want
      // a custom prefix (e.g. "Work Pi") can set it here and the dirname will
      // still be appended.
      defaultDisplayName: existing?.defaultDisplayName ?? "",
      defaultLabel: existing?.defaultLabel ?? "",
      preferredModels: existing?.preferredModels ?? [],
      // Full tool args/output in the trace on end-to-end-encrypted turns only
      // (the server sees ciphertext). Plaintext turns never use full mode.
      sealedFullTrace: existing?.sealedFullTrace ?? true,
      // Base mode that can include only Bash's command field. Tool results and
      // write/edit payloads remain hidden.
      traceMode: existing?.traceMode ?? "headline",
      // Create new linked scratchpads end-to-end encrypted (requires the bot
      // owner to have set up encryption in Threa).
      e2e: existing?.e2e ?? false,
    },
    null,
    2
  )
}

function parseConfigPatch(text: string): ConfigPatch {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object")
  }
  const candidate = parsed as Partial<ConfigPatch>
  for (const field of ["baseUrl", "workspaceId", "apiKey"] as const) {
    if (typeof candidate[field] !== "string" || candidate[field].trim().length === 0) {
      throw new Error(`Missing required config field: ${field}`)
    }
  }
  if (candidate.pollMs !== undefined && (typeof candidate.pollMs !== "number" || !Number.isFinite(candidate.pollMs))) {
    throw new Error("pollMs must be a number")
  }
  if (candidate.defaultDisplayName !== undefined && typeof candidate.defaultDisplayName !== "string") {
    throw new Error("defaultDisplayName must be a string")
  }
  if (candidate.defaultLabel !== undefined && typeof candidate.defaultLabel !== "string") {
    throw new Error("defaultLabel must be a string")
  }
  if (
    candidate.preferredModels !== undefined &&
    (!Array.isArray(candidate.preferredModels) || candidate.preferredModels.some((value) => typeof value !== "string"))
  ) {
    throw new Error("preferredModels must be an array of strings")
  }
  if (candidate.sealedFullTrace !== undefined && typeof candidate.sealedFullTrace !== "boolean") {
    throw new Error("sealedFullTrace must be a boolean")
  }
  if (candidate.traceMode !== undefined && !BASE_TRACE_MODE_SET.has(candidate.traceMode)) {
    throw new Error("traceMode must be headline or commands")
  }
  if (candidate.e2e !== undefined && typeof candidate.e2e !== "boolean") {
    throw new Error("e2e must be a boolean")
  }
  const { baseUrl, workspaceId, apiKey } = candidate as ConfigPatch
  return {
    baseUrl: baseUrl.trim(),
    workspaceId: workspaceId.trim(),
    apiKey: apiKey.trim(),
    pollMs: candidate.pollMs,
    defaultDisplayName: candidate.defaultDisplayName?.trim() || undefined,
    defaultLabel: candidate.defaultLabel?.trim() || undefined,
    preferredModels: candidate.preferredModels?.map((value) => value.trim()).filter((value) => value.length > 0),
    sealedFullTrace: candidate.sealedFullTrace,
    traceMode: candidate.traceMode,
    e2e: candidate.e2e,
  }
}

async function configureRemote(ctx: ExtensionCommandContext, args: string): Promise<void> {
  const existing = readStoredConfig()
  const input = args.trim() || (await ctx.ui.editor("Threa remote config", configTemplate(existing)))
  if (!input) return
  const patch = parseConfigPatch(input)
  const next = validateConfig({ ...existing, ...patch })
  if (!next) throw new Error(`Invalid ${CONFIG_PATH}`)
  const changedAuthOrTarget =
    !config ||
    config.baseUrl !== next.baseUrl ||
    config.workspaceId !== next.workspaceId ||
    config.apiKey !== next.apiKey
  config = next
  saveConfig()
  // If the workspace, base URL, or API key changed, the cached WS hint and any
  // open socket belong to the previous workspace. Tear them down so the next
  // /remote-control on resolves fresh against the new target.
  if (changedAuthOrTarget) teardownTransport()
  ctx.ui.notify(`Saved Threa remote config to ${CONFIG_PATH}`, "info")
}

async function fetchBotPrincipal(): Promise<BotPrincipal | null> {
  if (!config) return null
  const body = await request<{ data: BotPrincipal | { kind: string } }>(`/api/v1/workspaces/${config.workspaceId}/me`)
  return body.data.kind === "bot" ? (body.data as BotPrincipal) : null
}

function botTraitDiagnostics(principal: BotPrincipal | null): string[] {
  if (!principal) return ["bot=<not a bot key>"]
  const missing = ["active-scratchpad", "mentionable"].filter((trait) => !principal.traits.includes(trait))
  return [
    `bot=${principal.botId}`,
    `botTraits=${principal.traits.length > 0 ? principal.traits.join(",") : "<none>"}`,
    ...(missing.length > 0 ? [`missingTraits=${missing.join(",")}`] : []),
  ]
}

async function disableRemote(ctx: ExtensionContext): Promise<void> {
  if (!config) return
  const link = setCurrentSessionEnabled(ctx, false)
  if (!link) {
    ctx.ui.notify("No Threa remote session is linked here.", "warning")
    return
  }
  stopPolling()
  teardownTransport()
  await failPending("Threa remote disabled", ctx)
  await heartbeat("offline", undefined, ctx).catch(() => undefined)
  setRemoteStatus(ctx, "Threa remote: off")
  ctx.ui.notify(link ? "Threa remote disabled for this Pi session" : "No Threa remote session is linked here", "info")
}

async function enableRemote(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!config) return
  const link = setCurrentSessionEnabled(ctx, true)
  if (!link) {
    ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
    return
  }
  await tryRebindLegacySessionInstance(ctx)
  if (!(await verifySupervisedRevival(ctx))) {
    setRemoteStatus(ctx, "Threa remote: revival blocked")
    return
  }
  lastBusyHeartbeatAt = 0
  await heartbeat("available", undefined, ctx)
  // Backstop before dial, matching session_start: a stalled connect() must not
  // keep the poll loop from ever starting.
  startPolling(pi, ctx)
  await ensureTransport(pi, ctx)?.connect()
  ctx.ui.notify("Threa remote enabled for this Pi session", "info")
}

function describeContextAttachment(attachment: AttachmentSummary, downloadedAttachments: Map<string, string>): string {
  const localPath = downloadedAttachments.get(attachment.id)
  const localNote = localPath ? `, downloaded to ${localPath}` : ""
  return `[${attachment.id}] ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes${localNote})`
}

/**
 * The source message is left out of the history: {@link buildInvocationPrompt}
 * already appends its markdown under "Source message prompt", so a copy here
 * would hand the model the same request twice. Its attachments still need
 * announcing, hence their own block.
 */
function formatInvocationContext(
  messages: StreamMessage[],
  sourceMessageId: string,
  downloadedAttachments: Map<string, string>
): string {
  if (messages.length === 0) return ""
  const orderedMessages = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const historyLines = orderedMessages
    .filter((message) => message.id !== sourceMessageId)
    .map((message) => {
      const author = message.authorDisplayName || message.authorType
      const attachments = (message.attachments ?? [])
        .map((attachment) => describeContextAttachment(attachment, downloadedAttachments))
        .join("; ")
      return `- ${author}: ${message.content}${attachments ? `\n  Attachments: ${attachments}` : ""}`
    })
  const sourceAttachmentLines = (
    orderedMessages.find((message) => message.id === sourceMessageId)?.attachments ?? []
  ).map((attachment) => `- ${describeContextAttachment(attachment, downloadedAttachments)}`)
  return [
    historyLines.length > 0 ? ["Recent Threa stream context (oldest first):", ...historyLines].join("\n") : "",
    sourceAttachmentLines.length > 0 ? ["Attachments on the source message:", ...sourceAttachmentLines].join("\n") : "",
  ]
    .filter(Boolean)
    .join("\n\n")
}

function formatSteerPrompt(promptMarkdown: string, attachmentContext = ""): string {
  return [promptMarkdown.trim() || "(empty message)", attachmentContext].filter(Boolean).join("\n\n")
}

function formatSteerAttachmentContext(
  messages: StreamMessage[],
  sourceMessageId: string,
  downloadedAttachments: Map<string, string>
): string {
  const source = messages.find((message) => message.id === sourceMessageId)
  const lines = (source?.attachments ?? []).flatMap((attachment) => {
    const path = downloadedAttachments.get(attachment.id)
    return path ? [`- ${attachment.filename} (${attachment.mimeType}, ${attachment.sizeBytes} bytes) → ${path}`] : []
  })
  return lines.length > 0
    ? ["Attachments saved into this session's working directory — read them from these paths:", ...lines].join("\n")
    : ""
}

async function downloadAttachment(
  attachment: AttachmentSummary,
  invocation: ClaimedInvocation,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  if (!config) throw new Error("Threa remote config not loaded")
  const revision = invocation.sourceRevision
  const body = await request<{ data: { url: string } }>(
    `/api/v1/workspaces/${config.workspaceId}/attachments/${attachment.id}/url`,
    { signal }
  )
  // Timeout spans headers AND arrayBuffer() — a stalled download body must
  // reject, not hang the claim turn (same pathogen as the request() bound).
  const response = await fetch(body.data.url, {
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS), signal])
      : AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`download failed with ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  throwIfAborted(signal)
  if (cancelledInvocations.has(invocation) || invocation.sourceRevision !== revision)
    throw new Error("invocation changed")
  const path = attachmentLocalPath(join(cwd, ".threa-attachments", invocation.id), attachment.id, attachment.filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/**
 * The sealed sibling of {@link downloadAttachment}: the S3 object is opaque
 * ciphertext, so fetch it and decrypt locally with the key/iv the ref (opened
 * from the sealed message payload) carries — the file lands under its REAL
 * name, and decrypted bytes never transit the server.
 */
async function downloadSealedAttachment(
  ref: AttachmentRef,
  invocation: ClaimedInvocation,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  if (!config) throw new Error("Threa remote config not loaded")
  const revision = invocation.sourceRevision
  const body = await request<{ data: { url: string } }>(
    `/api/v1/workspaces/${config.workspaceId}/attachments/${ref.attachmentId}/url`,
    { signal }
  )
  const response = await fetch(body.data.url, {
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS), signal])
      : AbortSignal.timeout(ATTACHMENT_DOWNLOAD_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`download failed with ${response.status}`)
  const ciphertext = new Uint8Array(await response.arrayBuffer())
  throwIfAborted(signal)
  const bytes = await decryptAttachmentBytes({ ciphertext, key: ref.key, iv: ref.iv })
  throwIfAborted(signal)
  if (cancelledInvocations.has(invocation) || invocation.sourceRevision !== revision)
    throw new Error("invocation changed")
  const path = attachmentLocalPath(join(cwd, ".threa-attachments", invocation.id), ref.attachmentId, ref.filename)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

/**
 * Download + decrypt every attachment ref a sealed claim's payloads carried
 * (trigger first, deduped by id) and return manifest lines for the context
 * block. Any per-file failure throws — a sealed turn never runs on partial files.
 */
async function downloadSealedContextAttachments(
  promptRefs: readonly AttachmentRef[],
  historyRefs: readonly AttachmentRef[],
  invocation: ClaimedInvocation,
  cwd: string,
  signal?: AbortSignal
): Promise<{ contextLines: string[]; historyLines: string[]; sourceLines: string[] }> {
  const seen = new Set<string>()
  const historyLines: string[] = []
  const sourceLines: string[] = []
  for (const { refs, isSource } of [
    { refs: promptRefs, isSource: true },
    { refs: historyRefs, isSource: false },
  ]) {
    for (const ref of refs) {
      if (seen.has(ref.attachmentId)) continue
      seen.add(ref.attachmentId)
      const path = await downloadSealedAttachment(ref, invocation, cwd, signal)
      const line = `- ${ref.filename} (${ref.mimeType}, ${ref.sizeBytes} bytes) → ${path}`
      if (isSource) sourceLines.push(line)
      else historyLines.push(line)
    }
  }
  return {
    contextLines: [...sourceLines.map((line) => `${line} [attached to the source message]`), ...historyLines],
    historyLines,
    sourceLines,
  }
}

async function downloadContextAttachments(
  messages: StreamMessage[],
  invocation: ClaimedInvocation,
  cwd: string,
  strict = false,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const downloaded = new Map<string, string>()
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      try {
        downloaded.set(attachment.id, await downloadAttachment(attachment, invocation, cwd, signal))
      } catch (error) {
        if (strict) throw error
        console.warn(`Failed to download Threa attachment ${attachment.id}: ${String(error)}`)
      }
    }
  }
  return downloaded
}

async function fetchInvocationContext(
  invocation: ClaimedInvocation,
  cwd: string,
  sessionLink: RuntimeSessionLink | undefined,
  strict = false,
  signal?: AbortSignal
): Promise<{ context: string; steerContext: string; cursor?: string }> {
  if (!config) return { context: "", steerContext: "" }
  const cursor = sessionLink?.streamCursors?.[invocation.activeStreamId]
  const query = cursor ? `after=${encodeURIComponent(cursor)}&limit=50` : "limit=12"
  const body = await request<{ data: StreamMessage[] }>(
    `/api/v1/workspaces/${config.workspaceId}/streams/${invocation.activeStreamId}/messages?${query}`,
    { signal }
  )

  let sourceIncluded = body.data.some((message) => message.id === invocation.sourceMessageId)
  const messages = sourceIncluded
    ? body.data
    : (
        await request<{ data: StreamMessage[] }>(
          `/api/v1/workspaces/${config.workspaceId}/streams/${invocation.activeStreamId}/messages?limit=12`,
          { signal }
        )
      ).data
  sourceIncluded = messages.some((message) => message.id === invocation.sourceMessageId)
  if (strict && !sourceIncluded) throw new Error("source message missing from invocation context")
  const orderedMessages = [...messages].sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))
  const downloadedAttachments = await downloadContextAttachments(orderedMessages, invocation, cwd, strict, signal)
  throwIfAborted(signal)

  return {
    context: formatInvocationContext(orderedMessages, invocation.sourceMessageId, downloadedAttachments),
    steerContext: formatSteerAttachmentContext(orderedMessages, invocation.sourceMessageId, downloadedAttachments),
    cursor: sourceIncluded ? orderedMessages.at(-1)?.sequence : undefined,
  }
}

function buildClaimInvocationPayload(
  instanceId: string,
  runtimeSessionId: string,
  options?: { includeSessionControl?: boolean }
): Record<string, unknown> {
  const supportedCapabilities = ["active-scratchpad", "mentionable"]
  if (options?.includeSessionControl) supportedCapabilities.push(SESSION_CONTROL_CAPABILITY)
  return {
    runtimeKind: "pi-local",
    instanceId,
    runtimeSessionId,
    supportedCapabilities,
    claimTtlSeconds: CLAIM_TTL_SECONDS,
  }
}

function buildClaimInvocationBody(ctx: ExtensionContext): Record<string, unknown> {
  return buildClaimInvocationPayload(getSessionInstanceId(ctx), getRuntimeSessionId(ctx), {
    // During a rate-limit wait Pi is idle at the prompt, so session-control
    // commands are safe — and /model is the escape hatch from a throttled
    // provider, /carry-on the way to queue work for the retry.
    includeSessionControl: (!pending && ctx.isIdle()) || isWaitingForRetry,
  })
}

async function claimNextInvocation(ctx: ExtensionContext): Promise<ClaimedInvocation | null> {
  if (!config || reconnectPending || reloadPending || sessionTearingDown) return null
  const startedAt = Date.now()
  try {
    const body = await request<{ data: (ClaimedInvocation & { sealedContext?: unknown }) | null }>(
      `/api/v1/workspaces/${config.workspaceId}/bot-invocations/claim`,
      {
        method: "POST",
        body: JSON.stringify(buildClaimInvocationBody(ctx)),
      }
    )
    emitPollDebug(
      ctx,
      body.data
        ? `claimed ${body.data.id} in ${Date.now() - startedAt}ms`
        : `no invocation in ${Date.now() - startedAt}ms`
    )
    if (!body.data) return null
    consecutiveQuietPolls = 0
    const claimed = { ...body.data, claimedInstanceId: getSessionInstanceId(ctx) }
    if (claimed.sealedContext === undefined) return claimed
    return hydrateSealedClaim(claimed, ctx)
  } catch (error) {
    emitPollDebug(ctx, `failed after ${Date.now() - startedAt}ms: ${summarizeError(error)}`)
    throw error
  }
}

/**
 * Open a sealed claim with this install's BIK: decrypt the trigger + history,
 * set the decrypted trigger as the prompt, and stash the {@link SealingState}
 * every reply/step seals with. A failure fails the invocation loudly (with a
 * scrubbed, generic reason — the error could echo key material or content) and
 * returns null, rather than throwing up through the poll and leaving the claim
 * to TTL-recycle in a loop.
 */
async function hydrateSealedClaim(
  claimed: ClaimedInvocation & { sealedContext?: unknown },
  ctx: ExtensionContext
): Promise<ClaimedInvocation | null> {
  const fail = async (reason: string): Promise<null> => {
    emitPollDebug(ctx, `sealed claim ${claimed.id} unusable: ${reason}`)
    await failInvocationScrubbed(claimed, reason)
    return null
  }
  const sealed = parseSealedTurnContext(claimed.sealedContext)
  if (!sealed) return fail("malformed sealedContext")
  const bik = await bikKeystore.ensure()
  if (!bik) return fail("no bot identity key")
  // Wraps and the owner's message AAD bind to the ROOT stream that owns the
  // E2E key (a thread inherits the root's key), so hydrate against it.
  const streamId = claimed.rootStreamId ?? claimed.activeStreamId
  try {
    const opened = await openSealedTurnContext({ sealed, identity: bik, streamId })
    const historyLines = opened.history.map((item: DecryptedHistoryItem) => `- ${item.role}: ${item.contentMarkdown}`)
    const historyText =
      historyLines.length > 0 ? ["Recent Threa stream context (oldest first):", ...historyLines].join("\n") : ""
    return {
      ...claimed,
      sealedContext: undefined,
      promptMarkdown: opened.promptMarkdown,
      sealing: opened.sealing,
      sealedIdentity: bik,
      sealedHistoryContextText: historyText,
      sealedContextText: historyText,
      sealedSourceAttachmentRefs: opened.promptAttachmentRefs,
      sealedHistoryAttachmentRefs: opened.history.flatMap((item) => item.attachmentRefs),
    }
  } catch (error) {
    return fail(scrubSealedError(error))
  }
}

function applySealedAttachmentContext(
  invocation: ClaimedInvocation,
  attachments: { historyLines: string[]; sourceLines: string[] }
): void {
  const attachmentBlock = (lines: string[]) =>
    lines.length > 0
      ? ["Attachments saved into this session's working directory — read them from these paths:", ...lines].join("\n")
      : ""
  const sourceAttachmentText = attachmentBlock(attachments.sourceLines)
  invocation.sealedHistoryContextText = [invocation.sealedHistoryContextText, attachmentBlock(attachments.historyLines)]
    .filter(Boolean)
    .join("\n\n")
  invocation.sealedSteerContextText = sourceAttachmentText
  invocation.sealedContextText = [invocation.sealedHistoryContextText, sourceAttachmentText]
    .filter(Boolean)
    .join("\n\n")
}

async function prepareSealedClaim(invocation: ClaimedInvocation, ctx: ExtensionContext): Promise<void> {
  if (!invocation.sealing) return
  const revision = invocation.sourceRevision
  const attachments = await downloadSealedContextAttachments(
    invocation.sealedSourceAttachmentRefs ?? [],
    invocation.sealedHistoryAttachmentRefs ?? [],
    invocation,
    ctx.cwd
  )
  if (cancelledInvocations.has(invocation) || invocation.sourceRevision !== revision)
    throw new Error("stale sealed claim")
  applySealedAttachmentContext(invocation, attachments)
}

/** Fail an invocation with a generic, scrubbed reason — the sealed-path variant of {@link failInvocation}. */
async function failInvocationScrubbed(invocation: ClaimedInvocation, reason: string): Promise<void> {
  if (!config) return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/fail`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: getInvocationInstanceId(invocation),
      claimToken: invocation.claimToken,
      errorMessage: `Sealed turn failed: ${reason}`.slice(0, 200),
    }),
  }).catch(() => undefined)
}

/**
 * Seal a session-control command ack under the stream key, when the claim
 * carried the SSK wraps (an E2E scratchpad). Returns undefined on a plaintext
 * claim or a key race — the caller then takes the plaintext path, which closes
 * silently on E2E rather than showing the command as failed.
 */
async function sealSessionControlAck(
  invocation: ClaimedInvocation,
  markdown: string
): Promise<SealedReplyBody | undefined> {
  const ack = parseSealedAckContext(invocation.sealedAck)
  if (!ack) return undefined
  const bik = await bikKeystore.ensure()
  if (!bik) return undefined
  try {
    const streamId = invocation.rootStreamId ?? invocation.activeStreamId
    const sealing = await openSealedAck({ ack, identity: bik, streamId })
    return await sealReply(sealing, markdown)
  } catch {
    return undefined
  }
}

type RuntimeCommandMetadata = { id: string; name: string; args: string; executionKind: "bot-runtime" }

function getRuntimeCommand(invocation: ClaimedInvocation): RuntimeCommandMetadata | null {
  const command = invocation.metadata?.command
  if (!command || typeof command !== "object") return null
  const value = command as Record<string, unknown>
  if (value.executionKind !== "bot-runtime") return null
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.args !== "string") return null
  return { id: value.id, name: value.name, args: value.args, executionKind: "bot-runtime" }
}

function parseSessionControlCommand(promptMarkdown: string): { name: string; args: string } | null {
  const trimmed = promptMarkdown.trim()
  const match = trimmed.match(/^\/([\w-]+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!SESSION_CONTROL_COMMANDS.includes(name as PiSessionControlCommandName)) return null
  return { name, args: (match[2] ?? "").trim() }
}

function resolveSessionControlCommand(invocation: ClaimedInvocation): RuntimeCommandMetadata | null {
  const runtimeCommand = getRuntimeCommand(invocation)
  if (runtimeCommand) return runtimeCommand
  const parsed = parseSessionControlCommand(invocation.promptMarkdown)
  if (!parsed) return null
  if (invocation.requiredCapability !== SESSION_CONTROL_CAPABILITY) {
    // Legacy/API clients can still post bare session commands as normal
    // scratchpad messages. Preserve that fallback for every command except
    // steer: embedded steer deliberately creates a normal `/steer …` message
    // plus a separate structured session-control invocation.
    if (invocation.requiredCapability !== "active-scratchpad" || parsed.name === "steer") return null
  }
  return {
    id: invocation.sourceMessageId,
    name: parsed.name,
    args: parsed.args,
    executionKind: "bot-runtime",
  }
}

function isSessionControlInvocation(invocation: ClaimedInvocation): boolean {
  return resolveSessionControlCommand(invocation) !== null
}

function normalizeThinkingLevel(input: string): ThinkingLevel | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
  if (normalized === "none") return "off"
  if (normalized === "xhigh") return "xhigh"
  return THINKING_LEVELS.includes(normalized as ThinkingLevel) ? (normalized as ThinkingLevel) : null
}

async function completeInvocationWithMarkdown(
  invocation: ClaimedInvocation,
  finalMessageMarkdown: string,
  ctx?: ExtensionContext,
  deps: { sealAck?: typeof sealSessionControlAck } = {}
): Promise<boolean> {
  if (!config) return false
  const instanceId = getInvocationInstanceId(invocation)
  const revision = invocation.sourceRevision
  const observed = observedInvocations.get(invocation) ?? null
  const isCurrent = () => isInvocationWriteCurrent(invocation, revision, observed)
  if (!isCurrent()) return false
  try {
    const sealedReply = await (deps.sealAck ?? sealSessionControlAck)(invocation, finalMessageMarkdown)
    if (!isCurrent()) return false
    if (sealedReply) {
      try {
        await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
          method: "POST",
          body: JSON.stringify({
            instanceId,
            claimToken: invocation.claimToken,
            sourceRevision: revision,
            sealedReply,
            metadata: {
              "pi.remote.invocationId": invocation.id,
              "pi.remote.instanceId": instanceId,
              "pi.remote.sessionControl": "true",
            },
          }),
        })
      } catch {
        releaseObservation(invocation)
        return false
      }
      releaseObservation(invocation)
      return true
    }

    await recordInvocationTraceStep(invocation, "response", finalMessageMarkdown, "Composing response…")
    if (!isCurrent()) return false
    try {
      await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          instanceId,
          claimToken: invocation.claimToken,
          sourceRevision: revision,
          finalMessageMarkdown,
          metadata: {
            "pi.remote.invocationId": invocation.id,
            "pi.remote.instanceId": instanceId,
            "pi.remote.sessionControl": "true",
          },
        }),
      })
    } catch (error) {
      if (error instanceof ThreaApiError && error.status === 409 && error.code === "INVOCATION_INPUT_STALE") {
        releaseObservation(invocation)
        return false
      }
      if (!(error instanceof ThreaApiError && error.code === "E2E_STREAM_PLAINTEXT_UNSUPPORTED")) throw error
      if (!isCurrent()) return false
      try {
        await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
          method: "POST",
          body: JSON.stringify({
            instanceId,
            claimToken: invocation.claimToken,
            sourceRevision: revision,
            noResponse: true,
            metadata: {
              "pi.remote.invocationId": invocation.id,
              "pi.remote.instanceId": instanceId,
              "pi.remote.sessionControl": "true",
              "pi.remote.noResponse": "true",
            },
          }),
        })
      } catch {
        releaseObservation(invocation)
        return false
      }
      releaseObservation(invocation)
      return false
    }
    releaseObservation(invocation)
    return true
  } finally {
    lastBusyHeartbeatAt = 0
    const busy = reconnectPending || pending !== undefined || (ctx !== undefined && !ctx.isIdle())
    await heartbeat(busy ? "busy" : "available", busy ? "Busy in Pi…" : undefined, ctx).catch(() => undefined)
  }
}

async function buildInvocationPrompt(
  invocation: ClaimedInvocation,
  ctx: ExtensionContext,
  strict = false,
  promptMarkdown = invocation.promptMarkdown,
  signal?: AbortSignal
): Promise<{ prompt: string; steerPrompt: string; cursor?: string; context: string }> {
  // A sealed turn never touches the plaintext messages API — its context is
  // what was already decrypted at claim time (the server would only return
  // ciphertext placeholders anyway; inbound files were decrypted from the
  // payload refs during hydration).
  throwIfAborted(signal)
  const sealed = invocation.sealing !== undefined
  const { context, steerContext, cursor } = sealed
    ? {
        context: invocation.sealedContextText ?? "",
        steerContext: invocation.sealedSteerContextText ?? "",
        cursor: undefined,
      }
    : await fetchInvocationContext(invocation, ctx.cwd, getCurrentSessionLink(ctx), strict, signal).catch(
        (error): { context: string; steerContext: string; cursor?: string } => {
          if (strict) throw error
          ctx.ui.notify(`Threa remote context fetch failed: ${summarizeError(error)}`, "warning")
          return { context: "", steerContext: "" }
        }
      )
  throwIfAborted(signal)
  return {
    context,
    cursor,
    steerPrompt: formatSteerPrompt(promptMarkdown, steerContext),
    prompt: [
      `Remote Threa invocation ${invocation.id}.`,
      `Source message: ${invocation.sourceMessageId}`,
      "Respond normally; the extension will post your final answer back to Threa.",
      sealed
        ? "This scratchpad is end-to-end encrypted. To attach a local file to your reply, add a line exactly like `THREA_ATTACH: path/to/file`; the extension encrypts it locally and uploads only ciphertext."
        : "To attach a local file to your reply, add a line exactly like `THREA_ATTACH: path/to/file`; the extension will upload it and replace it with an attachment link.",
      context ? `\n${context}` : "",
      "\nSource message prompt:",
      promptMarkdown,
    ].join("\n"),
  }
}

function beginPendingInvocation(invocation: ClaimedInvocation, cursor?: string): void {
  clearContributorTerminalWrites()
  primaryCompletionCommitted = false
  pending = invocation
  pendingContextCursor = cursor
  pendingInvocationPrompt = undefined
  clearPendingRetry()
  isWaitingForRetry = false
  carryOnTexts = []
  lastTraceHeartbeat = undefined
}

function cancelPendingRetryTimer(): void {
  if (!pendingRetry?.timer) return
  clearTimeout(pendingRetry.timer)
  pendingRetry.timer = undefined
}

function clearPendingRetry(): void {
  cancelPendingRetryTimer()
  pendingRetry = undefined
}

function resetPendingTurnTexts(): void {
  activeOutputState = undefined
  lastTraceHeartbeat = undefined
}

function armPendingOutput(): void {
  resetPendingTurnTexts()
  promptEpoch++
  awaitingTurnStart = true
}

function activatePendingOutput(): void {
  if (!pending) return
  if (!awaitingTurnStart) return
  activeOutputState = {
    epoch: promptEpoch,
    invocation: pending,
    revision: pending.sourceRevision,
    assistantTexts: [],
    nonAssistantTexts: [],
    toolCalls: new Map(),
  }
  awaitingTurnStart = false
}

function currentPendingOutput(): PendingOutputState | undefined {
  const state = activeOutputState
  if (
    !state ||
    !pending ||
    awaitingTurnStart ||
    state.epoch !== promptEpoch ||
    state.invocation !== pending ||
    state.revision !== pending.sourceRevision
  ) {
    return undefined
  }
  return state
}

async function injectInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation,
  steer: boolean
): Promise<void> {
  const revision = invocation.sourceRevision
  const { prompt, steerPrompt, cursor, context } = await buildInvocationPrompt(invocation, ctx)
  const observed = observedInvocations.get(invocation)
  if (!observed || observed.state === "terminal" || observed.restartRequested || invocation.sourceRevision !== revision)
    return
  const deliveredPrompt = steer ? steerPrompt : prompt
  if (!pending) {
    beginPendingInvocation(invocation, cursor)
    pendingInvocationPrompt = deliveredPrompt
    await recordTraceStep("context_received", formatInvocationTrace(invocation, context), "Loaded context…")
  } else {
    steeredInvocations.push({ invocation, cursor, retryPrompt: deliveredPrompt })
    await recordInvocationTraceStep(
      invocation,
      "context_received",
      formatInvocationTrace(invocation, context),
      "Loaded context…"
    )
  }
  setRemoteStatus(ctx, `Threa remote: running ${pending.id}`)
  armPendingOutput()
  pi.sendUserMessage(deliveredPrompt, steer ? { deliverAs: "steer" } : undefined)
  observed.state = "running"
}

function compactSession(ctx: ExtensionContext, customInstructions?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      customInstructions: customInstructions?.trim() || undefined,
      onComplete: () => resolve(),
      onError: (error) => reject(error),
    })
  })
}

type ModelCandidate = { value: string; label: string; model: NonNullable<ExtensionContext["model"]> }

function getModelCandidates(ctx: ExtensionContext): ModelCandidate[] {
  return ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.input.includes("text"))
    .map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name, model }))
}

function groupModelCandidates(
  ctx: ExtensionContext,
  preferred: readonly string[]
): { preferred: ModelCandidate[]; reasoning: ModelCandidate[]; standard: ModelCandidate[] } {
  const candidates = getModelCandidates(ctx)
  const preferredLower = new Set(preferred.map((value) => value.toLowerCase()))
  const preferredList: ModelCandidate[] = []
  const reasoning: ModelCandidate[] = []
  const standard: ModelCandidate[] = []
  for (const candidate of candidates) {
    if (preferredLower.has(candidate.value.toLowerCase())) {
      preferredList.push(candidate)
      continue
    }
    if (candidate.model.reasoning === true) {
      reasoning.push(candidate)
    } else {
      standard.push(candidate)
    }
  }
  return { preferred: preferredList, reasoning, standard }
}

function renderModelGroup(title: string, candidates: ModelCandidate[]): string[] {
  if (candidates.length === 0) return []
  return [`**${title}**`, ...candidates.map((candidate) => `- \`${candidate.value}\` — ${candidate.label}`)]
}

function renderGroupedModelList(ctx: ExtensionContext): string {
  const groups = groupModelCandidates(ctx, config?.preferredModels ?? [])
  const sections = [
    ...renderModelGroup("Preferred", groups.preferred),
    ...renderModelGroup("Reasoning", groups.reasoning),
    ...renderModelGroup("Standard", groups.standard),
  ]
  return sections.join("\n")
}

function resolveModelCandidate(
  ctx: ExtensionContext,
  query: string
): { match?: ModelCandidate; candidates?: ModelCandidate[] } {
  const normalized = query.trim().toLowerCase()
  const candidates = getModelCandidates(ctx)
  if (!normalized) return { candidates: candidates.slice(0, 10) }

  const exact = candidates.filter(
    (candidate) =>
      candidate.value.toLowerCase() === normalized ||
      candidate.model.id.toLowerCase() === normalized ||
      candidate.label.toLowerCase() === normalized
  )
  if (exact.length === 1) return { match: exact[0] }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = candidates.filter(
    (candidate) =>
      candidate.value.toLowerCase().includes(normalized) || candidate.label.toLowerCase().includes(normalized)
  )
  if (fuzzy.length === 1) return { match: fuzzy[0] }
  return { candidates: fuzzy.slice(0, 10) }
}

type PiCommand = ReturnType<ExtensionAPI["getCommands"]>[number]

function displaySkillName(command: PiCommand): string {
  return command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name
}

function resolveSkillCommand(pi: ExtensionAPI, query: string): { match?: PiCommand; candidates: PiCommand[] } {
  const normalized = query.trim().toLowerCase()
  const skills = pi.getCommands().filter((command) => command.source === "skill")
  if (!normalized) return { candidates: skills.slice(0, 10) }

  const exact = skills.filter((command) => {
    const display = displaySkillName(command).toLowerCase()
    return command.name.toLowerCase() === normalized || display === normalized
  })
  if (exact.length === 1) return { match: exact[0], candidates: exact }
  if (exact.length > 1) return { candidates: exact.slice(0, 10) }

  const fuzzy = skills.filter((command) => {
    const haystack = [command.name, displaySkillName(command), command.description ?? ""].join(" ").toLowerCase()
    return haystack.includes(normalized)
  })
  if (fuzzy.length === 1) return { match: fuzzy[0], candidates: fuzzy }
  return { candidates: fuzzy.slice(0, 10) }
}

type InvocationGuard = () => boolean

async function runCompactCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  await recordInvocationTraceStep(invocation, "tool_call", "Compacting the linked Pi session…", "Compacting session…")
  if (!isCurrent()) return
  await compactSession(ctx, args)
  if (!isCurrent()) return
  await completeInvocationWithMarkdown(invocation, "Compacted the linked Pi session.", ctx)
}

async function runModelCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown"
  const trimmed = args.trim()
  const resolved = resolveModelCandidate(ctx, args)
  if (!resolved.match) {
    // No args: show the full grouped catalog (Preferred / Reasoning / Standard).
    // Ambiguous match: show just the candidates so the user can pick.
    const body = trimmed
      ? [
          `No unique model match for \`${trimmed}\`.`,
          "Candidates:",
          ...(resolved.candidates ?? []).map((candidate) => `- \`${candidate.value}\` — ${candidate.label}`),
        ].join("\n")
      : `Current model: \`${current}\`.\n\n${renderGroupedModelList(ctx)}`
    await completeInvocationWithMarkdown(invocation, body, ctx)
    return
  }

  const ok = await pi.setModel(resolved.match.model)
  if (!isCurrent()) return
  if (!ok) throw new Error(`No API key configured for ${resolved.match.value}`)
  await completeInvocationWithMarkdown(invocation, `Model changed: \`${current}\` → \`${resolved.match.value}\``, ctx)
}

async function runThinkingCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const level = normalizeThinkingLevel(args)
  if (!level) {
    await completeInvocationWithMarkdown(invocation, `Usage: \`/thinking ${THINKING_LEVELS.join("|")}\``, ctx)
    return
  }
  const before = pi.getThinkingLevel()
  pi.setThinkingLevel(level)
  const after = pi.getThinkingLevel()
  await completeInvocationWithMarkdown(invocation, `Thinking level changed: \`${before}\` → \`${after}\``, ctx)
}

async function runReloadCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  reloadPending = true
  try {
    const completed = await completeInvocationWithMarkdown(
      invocation,
      "Reloading Pi extensions, skills, prompts, and themes…",
      ctx
    )
    if (!completed) {
      reloadPending = false
      const busy = pending !== undefined || !ctx.isIdle()
      await heartbeat(busy ? "busy" : "available", busy ? "Busy in Pi…" : undefined, ctx).catch(() => undefined)
      return
    }
    pi.sendUserMessage(`/${RELOAD_HANDOFF_COMMAND}`, { deliverAs: "followUp" })
    // The handoff is not guaranteed to dispatch: on an idle session Pi has
    // been observed injecting the text as a MODEL prompt instead of running
    // the registered command (2026-08-10 — the model narrated "Reloading…
    // now.", ctx.reload never ran, and reloadPending latched heartbeats busy
    // and the claim loop off until a manual respawn). Calling ctx.reload()
    // directly from this non-command context is worse — it killed the whole
    // Pi process live. So the latch gets a watchdog: if no reload arrived,
    // release it, restore presence, and say so where the operator can see it.
    const generation = sessionLifecycleGeneration
    setTimeout(() => {
      if (!reloadPending || sessionLifecycleGeneration !== generation) return
      reloadPending = false
      ctx.ui.notify(
        "Threa reload handoff was not dispatched; run /reload in the Pi pane to reload manually.",
        "warning"
      )
      const busy = pending !== undefined || !ctx.isIdle()
      void heartbeat(busy ? "busy" : "available", busy ? "Busy in Pi…" : undefined, ctx).catch(() => undefined)
    }, reloadWatchdogMs)
  } catch (error) {
    reloadPending = false
    throw error
  }
}

type ShellExecResult = {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  elapsedMs: number
  spawnError: string | null
}

function appendCapped(existing: string, chunk: string, max: number): { text: string; truncated: boolean } {
  if (existing.length >= max) return { text: existing, truncated: true }
  const remaining = max - existing.length
  if (chunk.length <= remaining) return { text: existing + chunk, truncated: false }
  return { text: existing + chunk.slice(0, remaining), truncated: true }
}

function formatShellResult(command: string, result: ShellExecResult): string {
  // Single fenced block for stdout, separate block for stderr only when present
  // — keeps the common "ran cleanly with stdout" case readable. Footer is one
  // line of "exit N · 142ms · output truncated" so the human can scan it.
  const lines: string[] = ["```", `$ ${command}`]
  if (result.stdout.length > 0) lines.push(result.stdout.replace(/\n+$/, ""))
  lines.push("```")
  if (result.stderr.length > 0) {
    lines.push("**stderr**", "```", result.stderr.replace(/\n+$/, ""), "```")
  }
  const footer: string[] = []
  if (result.spawnError) {
    footer.push(`spawn failed: ${result.spawnError}`)
  } else if (result.timedOut) {
    footer.push(`timed out after ${formatShortDuration(result.elapsedMs)}`)
  } else if (result.signal) {
    footer.push(`signal ${result.signal}`)
    footer.push(formatShortDuration(result.elapsedMs))
  } else {
    footer.push(`exit ${result.exitCode ?? "?"}`)
    footer.push(formatShortDuration(result.elapsedMs))
  }
  if (result.stdoutTruncated || result.stderrTruncated) footer.push("output truncated")
  lines.push(footer.join(" · "))
  return lines.join("\n")
}

async function execShellCommand(
  command: string,
  cwd: string,
  options?: { timeoutMs?: number; sigkillGraceMs?: number }
): Promise<ShellExecResult> {
  // `$SHELL -c "<command>"` so pipes / redirects / globs / env-expansion all
  // work the way Pi's `!` does. `/bin/sh` is the portable fallback when SHELL
  // is unset (rare, but happens in stripped Docker images).
  const shell = process.env.SHELL ?? "/bin/sh"
  const timeoutMs = options?.timeoutMs ?? SHELL_TIMEOUT_MS
  const sigkillGraceMs = options?.sigkillGraceMs ?? 1_000
  const startedAt = Date.now()
  return new Promise<ShellExecResult>((resolvePromise) => {
    const child = spawn(shell, ["-c", command], { cwd, env: process.env })
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let settled = false
    const settle = (result: Omit<ShellExecResult, "elapsedMs">) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ...result, elapsedMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      // Escalate to SIGKILL if the child ignores SIGTERM. `child.killed` is
      // set the instant `kill()` is *called* — not when the process actually
      // exits — so it would be `true` here regardless and SIGKILL would never
      // fire. The `settled` flag, by contrast, only flips in the `exit`/
      // `error` handlers, so it tells us whether the child has actually
      // gone away. 1s is enough for a well-behaved process to flush; longer
      // waits keep the scratchpad in a busy state for no benefit.
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, sigkillGraceMs).unref()
    }, timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => {
      const { text, truncated } = appendCapped(stdout, chunk.toString("utf8"), SHELL_MAX_OUTPUT_CHARS)
      stdout = text
      if (truncated) stdoutTruncated = true
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const { text, truncated } = appendCapped(stderr, chunk.toString("utf8"), SHELL_MAX_OUTPUT_CHARS)
      stderr = text
      if (truncated) stderrTruncated = true
    })
    child.on("error", (err) => {
      settle({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: err instanceof Error ? err.message : String(err),
      })
    })
    child.on("close", (exitCode, signal) => {
      settle({
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        exitCode,
        signal,
        timedOut,
        spawnError: null,
      })
    })
  })
}

async function runShellCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const command = args.trim()
  if (command.length === 0) {
    await completeInvocationWithMarkdown(invocation, SHELL_USAGE, ctx)
    return
  }
  await recordInvocationTraceStep(invocation, "tool_call", `$ ${command}`, `Running shell…`)
  if (!isCurrent()) return
  const result = await execShellCommand(command, ctx.cwd)
  if (!isCurrent()) return
  await completeInvocationWithMarkdown(invocation, formatShellResult(command, result), ctx)
}

async function runSteerCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const steerText = args.trim()
  if (!steerText) {
    if (pending) {
      await recordTraceStep("steer", "Steer requested; checking for pending Threa messages.", "Steering…")
    }
    if (isCurrent()) await completeInvocationNoResponse(invocation)
    return
  }

  const steeredInvocation = { ...invocation, promptMarkdown: steerText }
  const { prompt, steerPrompt, cursor, context } = await buildInvocationPrompt(steeredInvocation, ctx)
  if (!isCurrent()) return
  const shouldSteer = pending !== undefined || !ctx.isIdle()
  const deliveredPrompt = shouldSteer ? steerPrompt : prompt
  if (!pending) {
    beginPendingInvocation(invocation, cursor)
    pendingInvocationPrompt = deliveredPrompt
    await recordTraceStep("context_received", formatInvocationTrace(steeredInvocation, context), "Loaded context…")
  } else {
    steeredInvocations.push({ invocation, cursor, retryPrompt: deliveredPrompt })
    await recordTraceStep("steer", formatInvocationTrace(steeredInvocation, context), "Steering…")
  }
  if (!isCurrent()) return
  setRemoteStatus(ctx, `Threa remote: running ${pending?.id ?? invocation.id}`)
  armPendingOutput()
  pi.sendUserMessage(deliveredPrompt, shouldSteer ? { deliverAs: "steer" } : undefined)
  const observed = observedInvocations.get(invocation)
  if (observed) observed.state = "running"
}

/**
 * /carry-on: queue text for the rate-limit retry. Only meaningful while a
 * retry wait is active — Pi's quota state is the pending retry, so outside a
 * wait a normal message is the right vehicle and we say so.
 */
async function runCarryOnCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const text = args.trim()
  if (!isWaitingForRetry) {
    await completeInvocationWithMarkdown(
      invocation,
      text
        ? "No rate-limit wait is active — send this as a normal message and the session will pick it up."
        : "No rate-limit wait is active; nothing to carry on from.",
      ctx
    )
    return
  }
  const retryAt = pendingRetry ? ` around ${formatLocalTime(new Date(pendingRetry.retryAt))}` : " soon"
  if (!text) {
    const queuedNote = carryOnTexts.length > 0 ? ` ${carryOnTexts.length} message(s) queued.` : ""
    await completeInvocationWithMarkdown(invocation, `Rate limited — retrying${retryAt}.${queuedNote}`, ctx)
    return
  }
  carryOnTexts.push(text)
  await completeInvocationWithMarkdown(invocation, `Queued — the retry${retryAt} folds it in.`, ctx)
}

async function runKickCommand(
  invocation: ClaimedInvocation,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const result = runHarnessKick(getRuntimeSessionId(ctx))
  if (!result.ok) throw new Error(result.error ?? "Harness daemon kick failed.")
  await completeInvocationWithMarkdown(invocation, "Kicked the linked Pi session.", ctx)
}

async function runKeyCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: {
    send: typeof sendAllowedTmuxKey
    complete: typeof completeInvocationWithMarkdown
  } = { send: sendAllowedTmuxKey, complete: completeInvocationWithMarkdown },
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const key = parseAllowedTmuxKey(args)
  if (!key) {
    await deps.complete(invocation, "Usage: `/key <name>`.", ctx)
    return
  }
  const link = currentSessionControlLink(ctx)
  if (!link || invocation.rootStreamId !== link.rootStreamId || invocation.claimedInstanceId !== link.instanceId) {
    throw new Error("Key control is unavailable for this session.")
  }
  deps.send(key, process.pid)
  await deps.complete(invocation, `Sent \`${key}\` to the linked Pi session.`, ctx)
}

interface ReconnectCommandDeps {
  available: () => boolean
  prepare: typeof prepareHarnessReconnect
  complete: typeof completeInvocationWithMarkdown
  heartbeat?: typeof heartbeat
}

interface ClearCommandDeps {
  available: () => boolean
  prepare: typeof prepareHarnessClear
  complete: typeof completeInvocationWithMarkdown
  heartbeat?: typeof heartbeat
}

interface SpawnCommandDeps {
  available: () => boolean
  postMessage: typeof postStreamMessage
  prepare: typeof prepareHarnessSpawn
  complete: typeof completeInvocationWithMarkdown
}

interface HarnessHandoffSpec {
  usage: string
  pendingMessage: string
  busyMessage: string
  unavailableMessage: string
  ackMessage: string
  heartbeatText: string
  prepare: (facts: { runtimeSessionId: string; rootStreamId: string; force: boolean }) => () => void
}

interface HarnessHandoffDeps {
  available: () => boolean
  complete: typeof completeInvocationWithMarkdown
  heartbeat?: typeof heartbeat
}

/**
 * A handoff latches the session busy until the harness restarts it. `done` may
 * instead refuse (the reaper's vetoes) and leave this pane alive, so the latch
 * needs a deadline or the pane never accepts another claim. The Claude session
 * carries the same 30 s fallback.
 */
export const HARNESS_HANDOFF_FALLBACK_MS = 30_000

function armHandoffFallback(
  lifecycleGeneration: number,
  ctx: ExtensionContext,
  sendHeartbeat: typeof heartbeat
): void {
  const timer = setTimeout(() => {
    if (!reconnectPending || sessionTearingDown || sessionLifecycleGeneration !== lifecycleGeneration) return
    reconnectPending = false
    const enabled = isEnabled(ctx)
    void sendHeartbeat(enabled ? (ctx.isIdle() && !pending ? "available" : "busy") : "offline", undefined, ctx).catch(
      () => undefined
    )
  }, HARNESS_HANDOFF_FALLBACK_MS)
  timer.unref?.()
}

async function runHarnessHandoffCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: HarnessHandoffDeps,
  spec: HarnessHandoffSpec,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const sendHeartbeat = deps.heartbeat ?? heartbeat
  if (args !== "" && args !== "--force") {
    await deps.complete(invocation, spec.usage, ctx)
    return
  }
  if (pending) {
    await deps.complete(invocation, spec.pendingMessage, ctx)
    return
  }
  if (args !== "--force" && !ctx.isIdle()) {
    await deps.complete(invocation, spec.busyMessage, ctx)
    return
  }
  const link = currentReconnectLink(ctx, deps.available)
  const lifecycleGeneration = sessionLifecycleGeneration
  const runtimeSessionId = getRuntimeSessionId(ctx)
  const instanceId = getSessionInstanceId(ctx)
  const invocationFacts = {
    rootStreamId: invocation.rootStreamId,
    claimedInstanceId: invocation.claimedInstanceId,
  }
  if (
    !link ||
    invocationFacts.rootStreamId !== link.rootStreamId ||
    invocationFacts.claimedInstanceId !== instanceId ||
    sessionTearingDown
  ) {
    throw new Error(spec.unavailableMessage)
  }
  const linkFacts = {
    instanceId: link.instanceId,
    runtimeSessionId: link.runtimeSessionId,
    rootStreamId: link.rootStreamId,
  }
  const start = spec.prepare({
    runtimeSessionId,
    rootStreamId: linkFacts.rootStreamId,
    force: args === "--force",
  })
  // The latch means "harness restart imminent — stay busy, accept no claims",
  // which is exactly what both handoffs are about to cause.
  reconnectPending = true
  await sendHeartbeat("busy", spec.heartbeatText, ctx).catch(() => undefined)
  if (!isCurrent()) {
    reconnectPending = false
    return
  }
  try {
    const acknowledged = await deps.complete(invocation, spec.ackMessage, ctx)
    const currentLink = currentReconnectLink(ctx, deps.available)
    const lifecycleChanged =
      sessionTearingDown ||
      sessionLifecycleGeneration !== lifecycleGeneration ||
      !currentLink ||
      currentLink.instanceId !== linkFacts.instanceId ||
      currentLink.runtimeSessionId !== linkFacts.runtimeSessionId ||
      currentLink.rootStreamId !== linkFacts.rootStreamId ||
      getRuntimeSessionId(ctx) !== runtimeSessionId ||
      getSessionInstanceId(ctx) !== instanceId ||
      invocation.rootStreamId !== invocationFacts.rootStreamId ||
      invocation.claimedInstanceId !== invocationFacts.claimedInstanceId
    if (!acknowledged || lifecycleChanged) {
      reconnectPending = false
      const enabled = isEnabled(ctx)
      await sendHeartbeat(
        enabled ? (ctx.isIdle() && !pending ? "available" : "busy") : "offline",
        undefined,
        ctx
      ).catch(() => undefined)
      return
    }
    start()
    armHandoffFallback(lifecycleGeneration, ctx, sendHeartbeat)
  } catch (error) {
    reconnectPending = false
    const enabled = isEnabled(ctx)
    await sendHeartbeat(enabled ? (ctx.isIdle() && !pending ? "available" : "busy") : "offline", undefined, ctx).catch(
      () => undefined
    )
    throw error
  }
}

async function runReconnectCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: ReconnectCommandDeps = {
    available: harnessReconnectAvailable,
    prepare: prepareHarnessReconnect,
    complete: completeInvocationWithMarkdown,
    heartbeat,
  },
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  await runHarnessHandoffCommand(
    invocation,
    args,
    ctx,
    deps,
    {
      usage: "Usage: `/reconnect [--force]`.",
      pendingMessage: "A Threa invocation is still running; use `/stop` before reconnecting.",
      busyMessage: "Pi is busy; retry when idle or use `/reconnect --force`.",
      unavailableMessage: "Harness reconnect is unavailable for this session.",
      ackMessage: "Reconnect request accepted; attempting to resume the linked Pi session.",
      heartbeatText: "Reconnect handoff…",
      prepare: ({ runtimeSessionId, rootStreamId, force }) => deps.prepare(runtimeSessionId, rootStreamId, { force }),
    },
    isCurrent
  )
}

async function runClearCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: ClearCommandDeps = {
    available: harnessReconnectAvailable,
    prepare: prepareHarnessClear,
    complete: completeInvocationWithMarkdown,
    heartbeat,
  },
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  await runHarnessHandoffCommand(
    invocation,
    args,
    ctx,
    deps,
    {
      usage: "Usage: `/clear [--force]`.",
      pendingMessage: "A Threa invocation is still running; use `/stop` before clearing.",
      busyMessage: "Pi is busy; retry when idle or use `/clear --force`.",
      unavailableMessage: "Harness clear is unavailable for this session.",
      ackMessage: "Clear accepted; killing this session and starting a fresh conversation on the same scratchpad.",
      heartbeatText: "Clear handoff…",
      prepare: ({ runtimeSessionId }) => deps.prepare(runtimeSessionId),
    },
    isCurrent
  )
}

async function postStreamMessage(streamId: string, content: string): Promise<string> {
  if (!config) throw new Error("Threa remote config not loaded")
  const body = await request<{ data?: { id?: string } }>(
    `/api/v1/workspaces/${config.workspaceId}/streams/${streamId}/messages`,
    { method: "POST", body: JSON.stringify({ content }) }
  )
  const id = body.data?.id
  if (!id) throw new Error(`Threa API returned no message id for stream ${streamId}`)
  return id
}

async function runSpawnCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: SpawnCommandDeps = {
    available: harnessReconnectAvailable,
    postMessage: postStreamMessage,
    prepare: prepareHarnessSpawn,
    complete: completeInvocationWithMarkdown,
  }
): Promise<void> {
  const parsed = parseSpawnCommandArgs(args)
  if ("error" in parsed) {
    await deps.complete(invocation, parsed.error, ctx)
    return
  }
  const link = currentReconnectLink(ctx, deps.available)
  if (!link) {
    await deps.complete(invocation, "Spawn is unavailable for this session.", ctx)
    return
  }
  if (link.activeStreamId !== link.rootStreamId) {
    await deps.complete(invocation, "Spawn is only available on the scratchpad root.", ctx)
    return
  }
  if (invocation.rootStreamId !== link.rootStreamId || invocation.claimedInstanceId !== link.instanceId) {
    throw new Error("Spawn request no longer matches the linked scratchpad.")
  }
  const runtime = parsed.runtime ?? "pi"
  const anchorId = await deps.postMessage(link.rootStreamId, `Starting **${parsed.name}** (${runtime})`)
  // harnessd dies on a blank brief, so an empty prompt gets no file at all.
  const briefFile = parsed.prompt ? writeSpawnBrief(parsed.prompt) : undefined
  try {
    deps.prepare({ runtime, name: parsed.name, rootStreamId: link.rootStreamId, anchorId, briefFile })()
  } catch (error) {
    discardSpawnBrief(briefFile)
    throw new Error(`Spawn launch failed after posting anchor ${anchorId}: ${summarizeError(error)}`)
  }
  await deps.complete(
    invocation,
    briefFile
      ? `Spawning **${parsed.name}** as a ${runtime} thread; harnessd will brief it with your prompt.`
      : `Spawning **${parsed.name}** as a ${runtime} thread.`,
    ctx
  )
}

async function runDoneCommand(
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  deps: HarnessHandoffDeps & { prepare: typeof prepareHarnessDone } = {
    available: harnessReconnectAvailable,
    prepare: prepareHarnessDone,
    complete: completeInvocationWithMarkdown,
    heartbeat,
  },
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const link = currentReconnectLink(ctx, deps.available)
  if (link && link.activeStreamId === link.rootStreamId) {
    await deps.complete(invocation, "Done is only available inside a thread session.", ctx)
    return
  }
  await runHarnessHandoffCommand(
    invocation,
    args,
    ctx,
    deps,
    {
      usage: "Usage: `/done [--force]`.",
      pendingMessage: "A Threa invocation is still running; use `/stop` before finishing.",
      busyMessage: "Pi is busy; retry when idle or use `/done --force`.",
      unavailableMessage: "Harness done is unavailable for this session.",
      ackMessage: "Wrapping up: committing, pushing, removing the worktree and ending this thread's session.",
      heartbeatText: "Done handoff…",
      prepare: ({ runtimeSessionId, rootStreamId }) => deps.prepare(runtimeSessionId, rootStreamId),
    },
    isCurrent
  )
}

async function runStopCommand(
  invocation: ClaimedInvocation,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const hadPendingRemoteInvocation = pending !== undefined
  const wasBusy = !ctx.isIdle()
  // completePending clears the carry-on queue with the rest of the retry
  // state — count first so the ack can say what the stop threw away.
  const droppedRetry = isWaitingForRetry
  const droppedCarryOns = carryOnTexts.length
  if (wasBusy) ctx.abort()
  if (hadPendingRemoteInvocation) {
    await completePending(NO_RESPONSE_MARKER, ctx)
  }
  if (!isCurrent()) return
  const stoppedNote = droppedRetry
    ? "Stopped the current Pi turn and dropped its scheduled rate-limit retry."
    : "Stopped the current Pi turn."
  const carryOnNote =
    droppedCarryOns > 0 ? ` Dropped ${droppedCarryOns} queued carry-on message(s); resend if still wanted.` : ""
  await completeInvocationWithMarkdown(
    invocation,
    wasBusy || hadPendingRemoteInvocation ? `${stoppedNote}${carryOnNote}` : "No Pi turn is running.",
    ctx
  )
}

async function runSkillCommand(
  pi: ExtensionAPI,
  invocation: ClaimedInvocation,
  args: string,
  ctx: ExtensionContext,
  isCurrent: InvocationGuard = () => true
): Promise<void> {
  const resolved = resolveSkillCommand(pi, args)
  if (!resolved.match) {
    const lines = [
      args.trim() ? `No unique skill match for \`${args.trim()}\`.` : "Tell me which skill to run.",
      "Candidates:",
      ...resolved.candidates.map(
        (candidate) => `- \`/${candidate.name}\`${candidate.description ? ` — ${candidate.description}` : ""}`
      ),
    ]
    await completeInvocationWithMarkdown(invocation, lines.join("\n"), ctx)
    return
  }

  if (!isCurrent()) return
  beginPendingInvocation(invocation)
  await recordInvocationTraceStep(
    invocation,
    "context_received",
    `Resolved /skill ${args} to /${resolved.match.name}`,
    "Resolved skill…"
  )
  if (!isCurrent()) return
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
  armPendingOutput()
  pi.sendUserMessage(`/${resolved.match.name}`)
}

async function handleSessionControlInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation
): Promise<void> {
  const command = resolveSessionControlCommand(invocation)
  if (!command) {
    await failInvocation(invocation, "Missing runtime command metadata")
    return
  }

  const isCurrent = () => {
    const observed = observedInvocations.get(invocation)
    return (
      !!observed && observed.state !== "terminal" && !observed.restartRequested && !cancelledInvocations.has(invocation)
    )
  }
  activeControlInvocation = invocation
  try {
    await heartbeat("busy", `Running /${command.name}…`, ctx)
    if (!isCurrent()) return
    await recordInvocationTraceStep(
      invocation,
      "context_received",
      `Running /${command.name}${command.args ? ` ${command.args}` : ""}`,
      `Running /${command.name}…`
    )
    if (!isCurrent()) return
    switch (command.name) {
      case "compact":
        await runCompactCommand(invocation, command.args, ctx, isCurrent)
        return
      case "model":
        await runModelCommand(pi, invocation, command.args, ctx, isCurrent)
        return
      case "thinking":
        await runThinkingCommand(pi, invocation, command.args, ctx, isCurrent)
        return
      case "skill":
        // /skill starts a fresh pending turn (beginPendingInvocation) — during
        // a rate-limit wait that would clobber the waiting invocation.
        if (isWaitingForRetry) {
          await completeInvocationWithMarkdown(
            invocation,
            "Session is waiting out a rate limit — run /skill again after the retry, or /stop first.",
            ctx
          )
          return
        }
        await runSkillCommand(pi, invocation, command.args, ctx, isCurrent)
        return
      case "reload":
        await runReloadCommand(pi, invocation, ctx, isCurrent)
        return
      case "shell":
        await runShellCommand(invocation, command.args, ctx, isCurrent)
        return
      case "steer":
        // Steering a rate-limited session would submit a prompt that dies the
        // same way — fold the text into the retry instead.
        if (isWaitingForRetry && command.args.trim()) {
          await runCarryOnCommand(invocation, command.args, ctx, isCurrent)
          return
        }
        await runSteerCommand(pi, invocation, command.args, ctx, isCurrent)
        return
      case "stop":
        await runStopCommand(invocation, ctx, isCurrent)
        return
      case "kick":
        await runKickCommand(invocation, ctx, isCurrent)
        return
      case "carry-on":
        await runCarryOnCommand(invocation, command.args, ctx, isCurrent)
        return
      case "reconnect":
        await runReconnectCommand(invocation, command.args, ctx, undefined, isCurrent)
        return
      case "clear":
        await runClearCommand(invocation, command.args, ctx, undefined, isCurrent)
        return
      case "spawn":
        await runSpawnCommand(invocation, command.args, ctx)
        return
      case "done":
        await runDoneCommand(invocation, command.args, ctx, undefined, isCurrent)
        return
      case "key":
        await runKeyCommand(invocation, command.args, ctx, undefined, isCurrent)
        return
      default:
        await failInvocation(invocation, `Unsupported session-control command: ${command.name}`)
    }
  } catch (error) {
    if (!isCurrent()) return
    await failInvocation(invocation, error)
  } finally {
    if (activeControlInvocation === invocation) activeControlInvocation = undefined
    // Every success path returns straight out of the switch with the entry
    // "Running /X…" busy presence still standing, so a no-turn command
    // (/stop with nothing to stop, /kick, /key) left the agent advertised
    // busy and not-accepting until some later turn happened to heartbeat.
    // A pending reload/reconnect handoff keeps busy on purpose: the restart
    // is imminent, and "available" would invite claims this process is about
    // to abandon.
    if (!reloadPending && !reconnectPending) {
      lastBusyHeartbeatAt = 0
      const busy = pending !== undefined || !ctx.isIdle()
      await heartbeat(busy ? "busy" : "available", busy ? "Busy in Pi…" : undefined, ctx).catch(() => undefined)
    }
  }
}

async function scheduleProviderRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  retryAfterMs: number,
  attempt: number
): Promise<void> {
  if (!pending) return
  const retryAt = Date.now() + retryAfterMs
  const notice = formatRetryNotice(retryAfterMs, attempt)
  const lifecycleGeneration = sessionLifecycleGeneration
  isWaitingForRetry = true
  pendingRetry = { retryAt, attempts: attempt }
  await recordTraceStep("rate_limited", notice, "Rate limited; waiting…").catch(() => undefined)
  if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration) return
  setRemoteStatus(ctx, `Threa remote: retry ${formatLocalTime(new Date(retryAt))}`)
  lastBusyHeartbeatAt = 0
  await heartbeat("busy", notice.slice(0, 160), ctx).catch(() => undefined)
  if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration || !pendingRetry) return
  pendingRetry.timer = setTimeout(
    () => {
      void executeProviderRetry(pi, ctx, attempt, lifecycleGeneration).catch(() => undefined)
    },
    Math.max(0, retryAt - Date.now())
  )
}

async function executeProviderRetry(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  attempt: number,
  lifecycleGeneration: number
): Promise<void> {
  if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration) return
  const invocation = pending
  if (!invocation) {
    pendingRetry = undefined
    isWaitingForRetry = false
    return
  }
  if (!pendingInvocationPrompt) {
    // No prompt is recorded for the active turn (e.g. /skill, which calls beginPendingInvocation and
    // then hands off to pi.sendUserMessage("/<skill>")). We can't auto-retry without the original
    // prompt, so surface the rate limit as a failure instead of silently holding the claim open.
    const providerError = activeOutputState?.providerError
    isWaitingForRetry = false
    await failPending(providerError ?? "Rate limited and unable to auto-retry this command.", ctx)
    return
  }
  const expectedObserved = observedInvocations.get(invocation)
  const isTerminallyInvalid = () =>
    pending !== invocation ||
    observedInvocations.get(invocation) !== expectedObserved ||
    cancelledInvocations.has(invocation) ||
    expectedObserved?.state === "terminal"
  const deferWhileUpdating = (): boolean => {
    if (!expectedObserved?.updateInProgress) return false
    const retryAt = Date.now() + 10
    pendingRetry = {
      retryAt,
      attempts: attempt,
      timer: setTimeout(
        () => void executeProviderRetry(pi, ctx, attempt, lifecycleGeneration).catch(() => undefined),
        10
      ),
    }
    isWaitingForRetry = true
    return true
  }
  resetPendingTurnTexts()
  await recordTraceStep(
    "rate_limit_retry",
    `Retrying after rate limit (attempt ${attempt} of ${MAX_RETRY_ATTEMPTS}).`,
    "Retrying…"
  ).catch(() => undefined)
  if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration || isTerminallyInvalid()) return
  if (deferWhileUpdating()) return
  setRemoteStatus(ctx, `Threa remote: running ${invocation.id}`)
  lastBusyHeartbeatAt = 0
  await heartbeat("busy", "Retrying after rate limit…", ctx).catch(() => undefined)
  if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration || isTerminallyInvalid()) return
  if (deferWhileUpdating()) return
  const primaryPrompt = pendingInvocationPrompt
  if (!primaryPrompt) return
  const queued = [...carryOnTexts]
  const contributorPrompts = steeredInvocations.flatMap((item) =>
    observedInvocations.get(item.invocation)?.state === "processing" ? [] : [item.retryPrompt]
  )
  pendingRetry = undefined
  isWaitingForRetry = false
  carryOnTexts = []
  armPendingOutput()
  pi.sendUserMessage(buildRetryPrompt([primaryPrompt, ...contributorPrompts].join("\n\n"), queued))
}

async function prepareRetryWaitContributor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: ClaimedInvocation,
  observed: ObservedInvocationContext,
  lifecycleGeneration: number
): Promise<boolean> {
  const revision = invocation.sourceRevision
  const contributor: SteeredInvocation = {
    invocation,
    retryPrompt: invocation.promptMarkdown.trim() || "(empty message)",
  }
  steeredInvocations.push(contributor)
  const isCurrent = () =>
    !sessionTearingDown &&
    lifecycleGeneration === sessionLifecycleGeneration &&
    observedInvocations.get(invocation) === observed &&
    observed.state !== "terminal" &&
    !observed.restartRequested &&
    invocation.sourceRevision === revision &&
    steeredInvocations.includes(contributor)
  const discard = () => {
    const index = steeredInvocations.indexOf(contributor)
    if (index >= 0) steeredInvocations.splice(index, 1)
  }
  try {
    if (invocation.sealing) await prepareSealedClaim(invocation, ctx)
    if (!isCurrent()) {
      discard()
      return false
    }
    const { steerPrompt, cursor, context } = await buildInvocationPrompt(invocation, ctx, true)
    if (!isCurrent()) {
      discard()
      return false
    }
    await recordInvocationTraceStep(
      invocation,
      "context_received",
      formatInvocationTrace(invocation, context),
      isWaitingForRetry ? "Queued for retry…" : "Steering…"
    )
    if (!isCurrent()) {
      discard()
      return false
    }
    contributor.cursor = cursor
    contributor.retryPrompt = steerPrompt
    observed.state = "running"
    // Persist ownership before either returning to a long retry wait or
    // steering a retry that fired while preparation awaited context I/O.
    savePendingSnapshot(ctx)
    if (isWaitingForRetry) return true
    armPendingOutput()
    pi.sendUserMessage(steerPrompt, { deliverAs: "steer" })
    return true
  } catch (error) {
    discard()
    throw error
  }
}

function claimIfIdle(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  if (sessionTearingDown) return Promise.resolve(false)
  claimIfIdleRerunRequested = true
  claimIfIdleInFlight ??= (async () => {
    let result = false
    while (claimIfIdleRerunRequested && !sessionTearingDown) {
      claimIfIdleRerunRequested = false
      result = await claimIfIdlePass(pi, ctx, sessionLifecycleGeneration)
    }
    return result
  })().finally(() => {
    claimIfIdleInFlight = undefined
  })
  return claimIfIdleInFlight
}

async function claimIfIdlePass(pi: ExtensionAPI, ctx: ExtensionContext, lifecycleGeneration: number): Promise<boolean> {
  if (!config || !isEnabled(ctx) || sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration)
    return false
  // No claims while detached: the scratchpad is archived, so any claimable work
  // predates it and would answer into a closed stream. A reattach re-drains.
  if (archive?.detached) return false
  if (primaryCompletionCommitted) {
    await heartbeatBusyIfStale("Closing combined Threa contributors…", ctx)
    return true
  }
  if (isWaitingForRetry) {
    const retryAt = pendingRetry ? formatLocalTime(new Date(pendingRetry.retryAt)) : "soon"
    await heartbeatBusyIfStale(`Rate limited; retrying around ${retryAt}`, ctx)
    // Keep draining claims during the wait: /stop must still cancel the retry,
    // /carry-on and /steer queue text for it, and plain messages fold in like
    // a steer sweep (N messages → the one retried response). Without this the
    // session is deaf until the retry fires.
    for (
      let claimedCount = 0;
      claimedCount < STEER_DRAIN_LIMIT && !sessionTearingDown && lifecycleGeneration === sessionLifecycleGeneration;
      claimedCount++
    ) {
      const invocation = await claimNextInvocation(ctx)
      if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration) {
        if (invocation) await failInvocation(invocation, "Pi session lifecycle changed while claiming")
        return false
      }
      if (!invocation) return true
      if (!(await observeInvocation(pi, ctx, invocation))) continue
      const observed = observedInvocations.get(invocation)
      if (!observed) continue
      observed.state = "processing"
      if (isSessionControlInvocation(invocation)) {
        await handleSessionControlInvocation(pi, ctx, invocation)
        // A /stop cancelled the wait (and possibly the turn) — stop sweeping.
        if (!isWaitingForRetry || reconnectPending) break
      } else {
        try {
          if (!(await prepareRetryWaitContributor(pi, ctx, invocation, observed, lifecycleGeneration))) continue
        } catch (error) {
          if (!cancelledInvocations.has(invocation)) await failInvocation(invocation, error)
          continue
        }
        // Preparation races the retry timer. A contributor installed while the
        // wait is still active is folded into the retry prompt; one installed
        // after it fires is steered live by prepareRetryWaitContributor.
        if (!isWaitingForRetry) break
      }
    }
    if (isWaitingForRetry && !sessionTearingDown && lifecycleGeneration === sessionLifecycleGeneration) {
      claimIfIdleRerunRequested = true
    }
    return true
  }

  for (
    let claimedCount = 0;
    claimedCount < STEER_DRAIN_LIMIT && !sessionTearingDown && lifecycleGeneration === sessionLifecycleGeneration;
    claimedCount++
  ) {
    const steer = pending !== undefined || !ctx.isIdle()
    if (steer) await heartbeatBusyIfStale(pending ? "Working on Threa invocation…" : "Busy in Pi…", ctx)

    const invocation = await claimNextInvocation(ctx)
    if (sessionTearingDown || lifecycleGeneration !== sessionLifecycleGeneration) {
      if (invocation) await failInvocation(invocation, "Pi session lifecycle changed while claiming")
      return false
    }
    if (!invocation) return true
    if (!(await observeInvocation(pi, ctx, invocation))) continue
    const observed = observedInvocations.get(invocation)
    if (!observed) continue
    observed.state = "processing"
    if (invocation.sealing) {
      try {
        await prepareSealedClaim(invocation, ctx)
      } catch {
        if (!cancelledInvocations.has(invocation))
          await failInvocation(invocation, "Sealed attachment preparation failed")
        continue
      }
    }
    if (isSessionControlInvocation(invocation)) {
      const command = resolveSessionControlCommand(invocation)
      await handleSessionControlInvocation(pi, ctx, invocation)
      if (command?.name === "stop" || reconnectPending || reloadPending) return true
    } else {
      await injectInvocation(pi, ctx, invocation, steer)
    }
  }
  if (!sessionTearingDown && lifecycleGeneration === sessionLifecycleGeneration) claimIfIdleRerunRequested = true
  return true
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text)
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function captureMessageText(message: unknown): { role: string; text: string } | null {
  if (!message || typeof message !== "object" || !("role" in message) || !("content" in message)) return null
  const role = String((message as { role: unknown }).role)
  // Skip user (our injected prompt echoed back) and tool (covered by tool_call/tool_result events).
  if (role === "user" || role === "tool") return null
  const text = textFromContent((message as { content: unknown }).content).trim()
  return text ? { role, text } : null
}

/**
 * An assistant message whose model call died carries the failure on the
 * message itself (`stopReason: "error"` + `errorMessage`) and usually has no
 * text content — so the text-capture path drops it entirely and the turn
 * "completes" silently. This is the only place that error is visible when the
 * provider throws instead of returning an HTTP response (a thrown 502 never
 * fires `after_provider_response`, so the turn's `providerError` stays unset).
 */
function extractModelError(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const raw = message as {
    role?: unknown
    stopReason?: unknown
    errorMessage?: unknown
    provider?: unknown
    model?: unknown
  }
  if (raw.role !== "assistant" || raw.stopReason !== "error") return undefined
  const detail =
    typeof raw.errorMessage === "string" && raw.errorMessage.trim().length > 0
      ? raw.errorMessage.trim()
      : "unknown error"
  const source =
    typeof raw.provider === "string" && typeof raw.model === "string" ? ` (${raw.provider}/${raw.model})` : ""
  return `⚠️ Model call failed${source}: ${detail}. Try /model to switch models.`
}

/**
 * Did the turn END in a model error? Scanning backwards, an error only counts
 * if no assistant message with real text came after it — a later successful
 * message means a retry recovered and the error is history, not the outcome.
 */
function trailingModelError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const error = extractModelError(messages[i])
    if (error) return error
    if (captureMessageText(messages[i])?.role === "assistant") return undefined
  }
  return undefined
}

function textFromAgentMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "Done."
  const captured = messages
    .map(captureMessageText)
    .filter((item): item is { role: string; text: string } => item !== null)
  if (captured.length === 0) return "Done."
  const assistant = captured
    .filter((item) => item.role === "assistant")
    // Same rationale as `resolveFinalText`: the final assistant message is the
    // answer; earlier ones are per-step narration that belongs in the trace,
    // not concatenated into the reply.
    .at(-1)
    ?.text.trim()
  if (assistant) return assistant
  return (
    captured
      .map((item) => item.text)
      .join("\n\n")
      .trim() || "Done."
  )
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) continue
    if (typeof value === "string") return value
    if (Array.isArray(value) && typeof value[0] === "string") return value[0]
  }
  return undefined
}

function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const raw = readHeader(headers, "retry-after")?.trim()
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
  }
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(0, parsed - now)
}

function formatLocalTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
}

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000)
  if (totalMin < 1) return "<1 min"
  if (totalMin < 60) return `${totalMin} min`
  const hours = Math.floor(totalMin / 60)
  const minutes = totalMin % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}

function formatShortDuration(ms: number): string {
  // Used in surfaces where typical durations are sub-minute (shell footers,
  // mostly). `formatDuration` rounds to whole minutes and collapses anything
  // shorter into "<1 min", which is useless for commands that finish in tens
  // of milliseconds. Fall through to `formatDuration` once we're past a
  // minute so longer-format strings stay consistent across the file.
  if (ms < 0) return formatDuration(ms)
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) {
    const seconds = ms / 1_000
    return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`
  }
  return formatDuration(ms)
}

function describeProviderError(status: number, headers: unknown, now: number = Date.now()): string {
  const retryAfterMs = parseRetryAfter(headers, now)
  if (status === 429) {
    if (retryAfterMs === undefined) return "Error: model provider rate-limited the request (HTTP 429)."
    const retryAt = new Date(now + retryAfterMs)
    return `Error: model provider rate-limited the request (HTTP 429). Try again around ${formatLocalTime(retryAt)} (in ~${formatDuration(retryAfterMs)}).`
  }
  if (status === 401 || status === 403) return `Error: model provider denied the request (HTTP ${status}).`
  if (status >= 500) return `Error: model provider returned a server error (HTTP ${status}).`
  return `Error: model provider returned HTTP ${status}.`
}

function formatRetryNotice(retryAfterMs: number, attempt: number, now: number = Date.now()): string {
  const retryAt = new Date(now + retryAfterMs)
  const attemptNote = attempt > 1 ? ` (attempt ${attempt} of ${MAX_RETRY_ATTEMPTS})` : ""
  return `Rate limited by model provider. Will retry around ${formatLocalTime(retryAt)} (in ~${formatDuration(retryAfterMs)})${attemptNote}.`
}

/** The retry prompt with any texts the user queued (via /carry-on or messages swept mid-wait) folded in. */
function buildRetryPrompt(prompt: string, queued: readonly string[]): string {
  if (queued.length === 0) return prompt
  return [
    prompt,
    "",
    "Instructions the user queued while the session was rate-limited (oldest first):",
    ...queued.map((text, i) => `${i + 1}. ${text}`),
  ].join("\n")
}

function extractAgentEndError(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined
  const error = (event as { error?: unknown }).error
  if (typeof error === "string") {
    const trimmed = error.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") {
      const trimmed = message.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
  }
  return undefined
}

/**
 * Pick the text to post as the Threa reply.
 *
 * During an agentic turn Pi emits one assistant message per step — the model
 * narrates each action ("Rebasing…", "Running the suite…") before producing
 * its final summary. Only that final assistant message is the user-facing
 * answer; the intermediate narration is shown in the scratchpad trace as
 * `thinking` steps (see the `message_end` handler) and must NOT be concatenated
 * into the reply, or the posted message balloons into a transcript of every
 * "I'm doing this" aside followed by the summary.
 */
function resolveFinalText(
  event: unknown,
  state: {
    assistantTexts: string[]
    otherTexts: Array<{ role: string; text: string }>
    providerError?: string
    modelError?: string
  }
): string {
  // Captured at `message_end` when the errored message streamed through, with
  // a scan of the turn's messages as backup for paths that bypass the pending
  // state. Either way, a turn that ended in a model error must say so — the
  // old behavior fell through to the "Done." fallback and posted a confident
  // no-op while every model call was failing.
  const modelError = state.modelError ?? trailingModelError((event as { messages?: unknown } | undefined)?.messages)
  if (state.assistantTexts.length > 0) {
    const answer = state.assistantTexts[state.assistantTexts.length - 1]
    // Narration followed by a dead final model call: posting the narration
    // alone reads as a finished answer, so carry the failure with it.
    return modelError ? `${answer}\n\n${modelError}` : answer
  }
  if (state.providerError) return state.providerError
  const eventError = extractAgentEndError(event)
  if (eventError) return eventError
  if (modelError) return modelError
  if (state.otherTexts.length > 0) return state.otherTexts.map((item) => item.text).join("\n\n")
  return textFromAgentMessages((event as { messages?: unknown } | undefined)?.messages)
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!isEnabled(ctx)) return
  stopPolling()
  const runId = ++pollingRunId
  const arm = (delayMs: number) => {
    if (runId !== pollingRunId) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void poll(), delayMs)
  }
  const poll = async () => {
    if (runId !== pollingRunId) return
    // Re-armed BEFORE any await: scheduling must not depend on the poll body
    // settling. When it does, one stalled response parks the loop with no timer
    // armed — presence frozen, claims dead, pane still "linked" (2026-08-10).
    // A completed poll's finally overrides this tick with its computed delay.
    arm(basePollMs())
    if (pollInFlightRunId !== undefined) return
    pollInFlightRunId = runId
    let delayMs = basePollMs()
    try {
      // Self-heal the /bot socket: if the hint resolve failed on enable /
      // session_start (transient blip), retry it here. connect() is guarded, so
      // while Socket.IO is mid-reconnect (socket present, not yet connected)
      // this is a no-op rather than a second dial. Deliberately NOT awaited:
      // the claim below is the backstop, and a dial that stalls must not hold
      // this worker (an in-flight worker skips every later tick).
      if (isEnabled(ctx) && !transport?.socketConnected) {
        void ensureTransport(pi, ctx)
          ?.connect()
          .catch((error) => emitPollDebug(ctx, `poll socket self-heal failed: ${summarizeError(error)}`))
      }
      await probeArchiveState(ctx)
      const contactedServer = await claimIfIdle(pi, ctx)
      if (contactedServer) notePollSuccess(ctx)
      delayMs = nextQuietPollMs()
    } catch (error) {
      notePollFailure(ctx, error)
      delayMs = failurePollMs()
    } finally {
      if (pollInFlightRunId === runId) pollInFlightRunId = undefined
      arm(delayMs)
    }
  }
  rearmPoll = arm
  void poll()
}

function advanceStreamCursor(invocation: ClaimedInvocation, ctx: ExtensionContext, cursor?: string): void {
  if (!config || !cursor) return
  const link = getCurrentSessionLink(ctx)
  if (!link) return
  link.streamCursors ??= {}
  link.streamCursors[invocation.activeStreamId] = cursor
  saveConfig()
}

function extractAttachmentDirectives(markdown: string): { markdown: string; paths: string[] } {
  const paths: string[] = []
  const lines = markdown.split("\n").filter((line) => {
    const match = line.match(/^THREA_ATTACH:\s*(.+?)\s*$/)
    if (!match) return true
    paths.push(match[1])
    return false
  })
  return { markdown: lines.join("\n").trim(), paths }
}

function guessMimeType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".html")) return "text/html"
  if (lower.endsWith(".md")) return "text/markdown"
  if (lower.endsWith(".txt")) return "text/plain"
  if (lower.endsWith(".csv")) return "text/csv"
  if (lower.endsWith(".pdf")) return "application/pdf"
  return "application/octet-stream"
}

async function uploadAttachment(path: string, cwd: string): Promise<UploadedAttachment> {
  if (!config) throw new Error("Threa remote config not loaded")
  const absolutePath = resolve(cwd, path)
  const stats = statSync(absolutePath)
  if (!stats.isFile()) throw new Error(`${path} is not a file`)
  const form = new FormData()
  const bytes = readFileSync(absolutePath)
  form.append("file", new Blob([bytes], { type: guessMimeType(absolutePath) }), basename(absolutePath))
  const body = await request<{ data: UploadedAttachment }>(`/api/v1/workspaces/${config.workspaceId}/attachments`, {
    method: "POST",
    body: form,
  })
  return body.data
}

async function prepareFinalMarkdown(
  markdown: string,
  cwd: string
): Promise<{ finalMarkdown: string; uploadedAttachments: UploadedAttachment[] }> {
  const extracted = extractAttachmentDirectives(markdown.trim())
  const uploadedAttachments: UploadedAttachment[] = []
  const failedUploads: string[] = []
  for (const path of extracted.paths) {
    try {
      uploadedAttachments.push(await uploadAttachment(path, cwd))
    } catch (error) {
      failedUploads.push(`${path}: ${String(error)}`)
    }
  }
  const attachmentLinks = uploadedAttachments.map(
    (attachment) => `- [${attachment.filename}](attachment:${attachment.id})`
  )
  const uploadFailureNote =
    failedUploads.length > 0
      ? ["Attachment upload failed:", ...failedUploads.map((failure) => `- ${failure}`)].join("\n")
      : ""
  return {
    finalMarkdown:
      [
        extracted.markdown || "Done.",
        attachmentLinks.length > 0 ? "Attachments:" : "",
        ...attachmentLinks,
        uploadFailureNote,
      ]
        .filter(Boolean)
        .join("\n\n") || "Done.",
    uploadedAttachments,
  }
}

function isAuthoritativeInvocationTerminalError(error: unknown): boolean {
  return (
    error instanceof ThreaApiError &&
    (error.status === 404 || (error.status === 409 && error.code === "INVOCATION_INPUT_STALE"))
  )
}

async function postInvocationNoResponse(invocation: ClaimedInvocation, revision: number): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  if (invocation.sealing) {
    await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/sealed-complete`, {
      method: "POST",
      headers: { [THREA_CALLBACK_TOKEN_HEADER]: invocation.sealing.callbackToken },
      body: JSON.stringify({ noResponse: true, sourceRevision: revision }),
    })
    return
  }
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: getInvocationInstanceId(invocation),
      claimToken: invocation.claimToken,
      sourceRevision: revision,
      noResponse: true,
      metadata: {
        "pi.remote.invocationId": invocation.id,
        "pi.remote.instanceId": getInvocationInstanceId(invocation),
        "pi.remote.noResponse": "true",
        "pi.remote.steered": "true",
      },
    }),
  })
}

async function postInvocationTerminalFailure(invocation: ClaimedInvocation): Promise<void> {
  if (!config) throw new Error("Threa remote config not loaded")
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/fail`, {
    method: "POST",
    body: JSON.stringify({
      instanceId: getInvocationInstanceId(invocation),
      claimToken: invocation.claimToken,
      errorMessage: "Combined Pi turn produced no separate response for this contributor",
    }),
  })
}

async function finishContributorTerminalWrite(owner: ContributorTerminalWrite): Promise<boolean> {
  if (contributorTerminalWrites.get(owner.invocation) !== owner) return false
  if (owner.timer) clearTimeout(owner.timer)
  contributorTerminalWrites.delete(owner.invocation)
  releaseObservation(owner.invocation)
  if (owner.ctx) await maybeFinalizeCommittedTurn(owner.ctx)
  return true
}

async function runContributorTerminalWrite(owner: ContributorTerminalWrite): Promise<boolean> {
  const invocation = owner.invocation
  const observed = observedInvocations.get(invocation) ?? null
  const revision = invocation.sourceRevision
  if (!isInvocationWriteCurrent(invocation, revision, observed)) {
    contributorTerminalWrites.delete(invocation)
    return false
  }
  if (owner.phase === "complete") {
    try {
      await postInvocationNoResponse(invocation, revision)
      return finishContributorTerminalWrite(owner)
    } catch (error) {
      if (isAuthoritativeInvocationTerminalError(error)) return finishContributorTerminalWrite(owner)
      owner.phase = "fail"
    }
  }
  const ownsCurrentWrite = () =>
    contributorTerminalWrites.get(invocation) === owner &&
    isInvocationWriteCurrent(invocation, invocation.sourceRevision, observed)
  for (
    let batchAttempt = 0;
    batchAttempt <= CONTRIBUTOR_FAIL_RETRY_DELAYS_MS.length && owner.failAttempts < MAX_CONTRIBUTOR_FAIL_ATTEMPTS;
    batchAttempt++
  ) {
    if (!ownsCurrentWrite()) return false
    if (batchAttempt > 0) await Bun.sleep(CONTRIBUTOR_FAIL_RETRY_DELAYS_MS[batchAttempt - 1]!)
    if (!ownsCurrentWrite()) return false
    owner.failAttempts++
    try {
      await postInvocationTerminalFailure(invocation)
      return finishContributorTerminalWrite(owner)
    } catch (error) {
      if (isAuthoritativeInvocationTerminalError(error)) return finishContributorTerminalWrite(owner)
    }
  }
  if (!sessionTearingDown && contributorTerminalWrites.get(invocation) === owner) {
    const batchExhausted = owner.failAttempts >= MAX_CONTRIBUTOR_FAIL_ATTEMPTS
    if (batchExhausted) owner.failAttempts = 0
    owner.timer = setTimeout(
      () => {
        owner.timer = undefined
        owner.running = runContributorTerminalWrite(owner).finally(() => {
          if (contributorTerminalWrites.get(invocation) === owner) owner.running = undefined
        })
      },
      batchExhausted ? CONTRIBUTOR_FAIL_RETRY_COOLDOWN_MS : CONTRIBUTOR_FAIL_RETRY_BATCH_DELAY_MS
    )
  }
  return false
}

async function completeInvocationNoResponse(invocation: ClaimedInvocation, ctx?: ExtensionContext): Promise<boolean> {
  if (!config) return false
  let owner = contributorTerminalWrites.get(invocation)
  if (!owner) {
    owner = { invocation, phase: "complete", failAttempts: 0, ctx }
    contributorTerminalWrites.set(invocation, owner)
  } else if (ctx) {
    owner.ctx = ctx
  }
  if (!owner.running && !owner.timer) {
    owner.running = runContributorTerminalWrite(owner).finally(() => {
      if (contributorTerminalWrites.get(invocation) === owner) owner.running = undefined
    })
  }
  return owner.running
}

async function failInvocation(invocation: ClaimedInvocation, error: unknown): Promise<void> {
  if (!config) return
  const revision = invocation.sourceRevision
  const observed = observedInvocations.get(invocation) ?? null
  if (!isInvocationWriteCurrent(invocation, revision, observed)) return
  // A sealed turn's error text could echo decrypted content — send only the
  // error's class name (the enclave's failure path is the same shape).
  const errorMessage = invocation.sealing
    ? `Sealed turn failed: ${scrubSealedError(error)}`
    : String(error).slice(0, 1000)
  try {
    await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/fail`, {
      method: "POST",
      body: JSON.stringify({
        instanceId: getInvocationInstanceId(invocation),
        claimToken: invocation.claimToken,
        errorMessage,
      }),
    }).catch(() => undefined)
  } finally {
    if (isInvocationWriteCurrent(invocation, revision, observed)) releaseObservation(invocation)
  }
}

/**
 * The sealed sibling of {@link uploadAttachment}: encrypt the file under a
 * fresh single-use key and upload ONLY the ciphertext (`e2e=true`, placeholder
 * name/mime). The returned ref carries the key/iv + real metadata, which seal
 * into the reply payload — plaintext file bytes never leave the machine.
 */
async function uploadSealedAttachment(path: string, cwd: string): Promise<AttachmentRef> {
  if (!config) throw new Error("Threa remote config not loaded")
  const absolutePath = resolve(cwd, path)
  const stats = statSync(absolutePath)
  if (!stats.isFile()) throw new Error(`${path} is not a file`)
  const bytes = readFileSync(absolutePath)
  const encrypted = await encryptAttachmentBytes(bytes)
  const form = new FormData()
  form.append("e2e", "true")
  form.append("file", new Blob([encrypted.ciphertext], { type: "application/octet-stream" }), "encrypted")
  const body = await request<{ data: UploadedAttachment }>(`/api/v1/workspaces/${config.workspaceId}/attachments`, {
    method: "POST",
    body: form,
  })
  return {
    attachmentId: body.data.id,
    key: encrypted.key,
    iv: encrypted.iv,
    filename: basename(absolutePath),
    mimeType: guessMimeType(absolutePath),
    sizeBytes: bytes.length,
  }
}

/**
 * Sealed sibling of the plaintext complete: encrypt + upload any local
 * attachment directives (ciphertext only; the per-file keys seal into the
 * payload's `attachmentRefs`), seal the final markdown under the stream key,
 * and post it to `/sealed-complete` (callback-token auth). No `attachment:<id>`
 * links — an E2E viewer renders attachments from the sealed refs.
 */
async function completeSealedWithMarkdown(
  invocation: ClaimedInvocation,
  sealing: SealingState,
  markdown: string,
  cwd: string
): Promise<void> {
  if (!config) return
  const revision = invocation.sourceRevision
  const extracted = extractAttachmentDirectives(markdown.trim())
  const noResponse = extracted.markdown === NO_RESPONSE_MARKER || (!extracted.markdown && extracted.paths.length === 0)
  if (noResponse) {
    await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/sealed-complete`, {
      method: "POST",
      headers: { [THREA_CALLBACK_TOKEN_HEADER]: sealing.callbackToken },
      body: JSON.stringify({ noResponse: true, sourceRevision: invocation.sourceRevision }),
    })
    return
  }
  const refs: AttachmentRef[] = []
  const failedUploads: string[] = []
  // Server cap on attachmentIds per sealed message (sealedAttachmentIdsSchema
  // .max(16)) — clamp before uploading or the whole completion 400s forever.
  for (const path of extracted.paths.slice(MAX_SEALED_ATTACHMENTS_PER_MESSAGE)) {
    failedUploads.push(`${path}: over the ${MAX_SEALED_ATTACHMENTS_PER_MESSAGE}-attachment limit for one message`)
  }
  for (const path of extracted.paths.slice(0, MAX_SEALED_ATTACHMENTS_PER_MESSAGE)) {
    try {
      refs.push(await uploadSealedAttachment(path, cwd))
    } catch (error) {
      failedUploads.push(`${path}: ${String(error)}`)
    }
  }
  if (cancelledInvocations.has(invocation) || invocation.sourceRevision !== revision || invocation.sealing !== sealing)
    return
  const uploadFailureNote =
    failedUploads.length > 0
      ? ["Attachment upload failed:", ...failedUploads.map((failure) => `- ${failure}`)].join("\n")
      : ""
  const finalMarkdown = [extracted.markdown || "Done.", uploadFailureNote].filter(Boolean).join("\n\n")
  const reply = await sealReply(sealing, finalMarkdown, refs.length > 0 ? { attachmentRefs: refs } : undefined)
  if (cancelledInvocations.has(invocation) || invocation.sourceRevision !== revision || invocation.sealing !== sealing)
    return
  await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/sealed-complete`, {
    method: "POST",
    headers: { [THREA_CALLBACK_TOKEN_HEADER]: sealing.callbackToken },
    body: JSON.stringify({
      sourceRevision: invocation.sourceRevision,
      reply: {
        ...reply,
        ...(refs.length > 0 && { attachmentIds: refs.map((ref) => ref.attachmentId) }),
      },
    }),
  })
}

async function maybeFinalizeCommittedTurn(ctx: ExtensionContext): Promise<boolean> {
  if (!primaryCompletionCommitted || !pending) return false
  if (contributorTerminalWrites.size > 0) return false
  if (steeredInvocations.some((item) => observedInvocations.has(item.invocation))) return false
  const invocation = pending
  const steered = [...steeredInvocations]
  const primaryCursor = pendingContextCursor
  advanceStreamCursor(invocation, ctx, primaryCursor)
  for (const item of steered) advanceStreamCursor(item.invocation, ctx, item.cursor)
  releaseObservation(invocation)
  for (const item of steered) releaseObservation(item.invocation)
  clearTurnState()
  lastBusyHeartbeatAt = 0
  clearPendingSnapshot(ctx)
  clearRecoveredCompletionTimer()
  await heartbeat("available", undefined, ctx).catch(() => undefined)
  return true
}

async function completePending(
  markdown: string,
  ctx: ExtensionContext,
  expected?: { invocation: ClaimedInvocation; revision: number; epoch: number }
): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  if (
    expected &&
    (invocation !== expected.invocation ||
      invocation.sourceRevision !== expected.revision ||
      promptEpoch !== expected.epoch)
  )
    return
  const observed = observedInvocations.get(invocation) ?? null
  const revision = invocation.sourceRevision
  if (!primaryCompletionCommitted) {
    if (!isInvocationWriteCurrent(invocation, revision, observed) || observed?.updateInProgress) return
    if (invocation.sealing) {
      await completeSealedWithMarkdown(invocation, invocation.sealing, markdown, ctx.cwd)
    } else {
      const { finalMarkdown, uploadedAttachments } = await prepareFinalMarkdown(markdown, ctx.cwd)
      if (
        !isInvocationWriteCurrent(invocation, revision, observed) ||
        observed?.updateInProgress ||
        (expected && promptEpoch !== expected.epoch)
      )
        return
      const noResponse = finalMarkdown === NO_RESPONSE_MARKER
      await request(`/api/v1/workspaces/${config.workspaceId}/bot-invocations/${invocation.id}/complete`, {
        method: "POST",
        body: JSON.stringify({
          instanceId: getInvocationInstanceId(invocation),
          claimToken: invocation.claimToken,
          sourceRevision: invocation.sourceRevision,
          ...(noResponse ? { noResponse: true } : { finalMessageMarkdown: finalMarkdown }),
          metadata: {
            "pi.remote.invocationId": invocation.id,
            "pi.remote.instanceId": getInvocationInstanceId(invocation),
            ...(noResponse && { "pi.remote.noResponse": "true" }),
            ...(uploadedAttachments.length > 0 && {
              "pi.remote.attachmentIds": uploadedAttachments.map((attachment) => attachment.id).join(","),
            }),
          },
        }),
      })
    }
    if (!isInvocationWriteCurrent(invocation, revision, observed)) return
    primaryCompletionCommitted = true
    releaseObservation(invocation)
    for (const item of steeredInvocations) {
      const contributor = observedInvocations.get(item.invocation)
      if (contributor) contributor.state = "terminalizing"
    }
    savePendingSnapshot(ctx)
  }
  const steered = [...steeredInvocations]
  await Promise.all(steered.map((item) => completeInvocationNoResponse(item.invocation, ctx)))
  await maybeFinalizeCommittedTurn(ctx)
}

async function failPending(error: unknown, ctx?: ExtensionContext): Promise<void> {
  if (!config || !pending) return
  const invocation = pending
  const steered = steeredInvocations
  // Queued carry-on texts die with the turn — say so instead of a silent drop.
  const droppedNote =
    carryOnTexts.length > 0
      ? ` Dropped ${carryOnTexts.length} queued carry-on message(s); resend when the session is available.`
      : ""
  carryOnTexts = []
  if (droppedNote) error = `${String(error)}${droppedNote}`
  await failInvocation(invocation, error)
  await Promise.all(steered.map((item) => failInvocation(item.invocation, error)))
  releaseObservation(invocation)
  for (const item of steered) releaseObservation(item.invocation)
  clearTurnState()
  lastBusyHeartbeatAt = 0
  if (ctx) clearPendingSnapshot(ctx)
  clearRecoveredCompletionTimer()
  await heartbeat("available", undefined, ctx).catch(() => undefined)
}

async function setStorageDirectoryForTesting(directory: string): Promise<void> {
  if (!isTestEntrypoint()) throw new Error("Test storage can only be configured under bun test")
  await resetRuntimeForTesting()
  const resolved = resolve(directory)
  PENDING_SNAPSHOT_DIRECTORY = resolved
  CONFIG_PATH = join(resolved, "threa-remote.json")
  CONFIG_LOCK_PATH = `${CONFIG_PATH}.lock`
  BIK_PATH = join(resolved, "threa-remote-bik.json")
  bikKeystore = createBikKeystore(BIK_PATH)
}

async function resetRuntimeForTesting(): Promise<void> {
  sessionTearingDown = true
  sessionLifecycleGeneration++
  reconnectPending = false
  reloadPending = false
  stopPolling()
  releaseAllObservations()
  clearPendingRetry()
  clearRecoveredCompletionTimer()
  teardownTransport()
  await claimIfIdleInFlight?.catch(() => undefined)
  await pendingSettlement?.catch(() => undefined)
  claimIfIdleInFlight = undefined
  pendingSettlement = undefined
  activeControlInvocation = undefined
  claimIfIdleRerunRequested = false
  config = undefined
  pollInFlightRunId = undefined
  pending = undefined
  steeredInvocations = []
  clearContributorTerminalWrites()
  primaryCompletionCommitted = false
  pendingContextCursor = undefined
  pendingInvocationPrompt = undefined
  isWaitingForRetry = false
  promptEpoch = 0
  awaitingTurnStart = false
  activeOutputState = undefined
  carryOnTexts = []
  lastTraceHeartbeat = undefined
  consecutivePollFailures = 0
  consecutiveQuietPolls = 0
  lastPollFailureSummary = undefined
  lastBusyHeartbeatAt = 0
  lastPollDebugSummary = undefined
  fallbackRuntimeSessionId = undefined
  supervisedRevivalBlocked = false
  sessionTearingDown = false
}

export const __testing = {
  piManifest: PI_MANIFEST,
  presenceBody,
  buildRetryPrompt,
  describeToolCall,
  formatToolCallTrace,
  formatToolResultTrace,
  fullToolArgumentSummary,
  shouldEmitFullTrace,
  traceModeForInvocation,
  completeSealedWithMarkdown,
  downloadSealedContextAttachments,
  setConfigForTesting: (value: unknown) => {
    config = value as Config | undefined
  },
  setReloadWatchdogMsForTesting: (value: number) => {
    reloadWatchdogMs = value
  },
  setSupervisedRevivalBlockedForTesting: (value: boolean) => {
    supervisedRevivalBlocked = value
  },
  probeArchiveState,
  handleArchivePush,
  handleRestorePush,
  archiveDetached: () => archive?.detached ?? false,
  archivePendingRootStreamId: () => archive?.pendingRootStreamId,
  setArchivePendingForTesting: (ctx: ExtensionContext, rootStreamId: string) =>
    ensureArchiveController(ctx).archived(rootStreamId),
  setArchiveWindDownForTesting: (graceMs: number, killWindow: typeof killOwnWindow) => {
    archiveGraceMs = graceMs
    archiveKillWindow = killWindow
  },
  clearArchivePendingForTesting: () => {
    archive?.stop()
    archive = undefined
    archiveGraceMs = undefined
    archiveKillWindow = killOwnWindow
  },
  setRateLimitWaitForTesting: (value: boolean) => {
    isWaitingForRetry = value
  },
  setStorageDirectoryForTesting,
  storagePaths: () => ({ configPath: CONFIG_PATH, lockPath: CONFIG_LOCK_PATH, bikPath: BIK_PATH }),
  pendingSnapshotPathForTesting: (runtimeSessionId: string) => pendingSnapshotPath(runtimeSessionId),
  pendingInvocationId: () => pending?.id,
  pendingInvocationState: () =>
    pending
      ? {
          id: pending.id,
          sourceRevision: pending.sourceRevision,
          promptMarkdown: pending.promptMarkdown,
          invocationPrompt: pendingInvocationPrompt,
          sealedHistoryContextText: pending.sealedHistoryContextText,
          sealedContextText: pending.sealedContextText,
        }
      : undefined,
  observedInvocationCount: () => observedInvocations.size,
  observedInvocationStates: () =>
    [...observedInvocations.values()].map((item) => ({
      id: item.invocation.id,
      state: item.state,
      updateInProgress: item.updateInProgress,
      restartRequested: item.restartRequested,
    })),
  observeInvocation,
  restorePendingAfterReload,
  savePendingSnapshot,
  prepareSealedClaim,
  handleSessionControlInvocation,
  executeProviderRetry,
  prepareRetryWaitContributor: (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    invocation: ClaimedInvocation,
    lifecycleGeneration: number
  ) => {
    const observed = observedInvocations.get(invocation)
    if (!observed) throw new Error("invocation is not observed")
    return prepareRetryWaitContributor(pi, ctx, invocation, observed, lifecycleGeneration)
  },
  completeInvocationNoResponse,
  completePending,
  armPendingOutputForTesting: () => armPendingOutput(),
  setPendingRuntimeForTesting: (value: {
    invocationPrompt?: string
    steered?: Array<{ invocation: ClaimedInvocation; cursor?: string; retryPrompt: string }>
    waitingForRetry?: boolean
    retryAt?: number
    retryAttempts?: number
    carryOns?: string[]
  }) => {
    if ("invocationPrompt" in value) pendingInvocationPrompt = value.invocationPrompt
    if (value.steered) steeredInvocations = value.steered
    if (value.waitingForRetry !== undefined) {
      clearPendingRetry()
      isWaitingForRetry = value.waitingForRetry
    }
    if (value.waitingForRetry) {
      pendingRetry = {
        retryAt: value.retryAt ?? Date.now(),
        attempts: value.retryAttempts ?? 1,
      }
    }
    if (value.carryOns) carryOnTexts = [...value.carryOns]
  },
  pendingRuntimeState: () => ({
    invocationPrompt: pendingInvocationPrompt,
    waitingForRetry: isWaitingForRetry,
    steered: steeredInvocations.map((item) => ({
      id: item.invocation.id,
      sourceRevision: item.invocation.sourceRevision,
      retryPrompt: item.retryPrompt,
    })),
    promptEpoch,
    outputEpoch: activeOutputState?.epoch,
    primaryCompleted: primaryCompletionCommitted,
    terminalWriteOwners: contributorTerminalWrites.size,
  }),
  setTransportForTesting: (value: unknown) => {
    transport = value as BotRuntimeTransport | undefined
  },
  defaultStorageDirectoryForTesting: (entrypoint?: string) =>
    isTestEntrypoint(entrypoint)
      ? join(tmpdir(), `threa-pi-remote-tests-${process.pid}`)
      : PRODUCTION_STORAGE_DIRECTORY,
  resetRuntimeForTesting,
  buildClaimInvocationPayload,
  buildPersistedConfig,
  buildRuntimeCapabilities,
  getRuntimeCommand,
  parseSessionControlCommand,
  formatSteerPrompt,
  formatInvocationContext,
  resolveSessionControlCommand,
  normalizeThinkingLevel,
  migrateSessionState,
  buildScratchpadUrl,
  parseConfigPatch,
  safeStatusText,
  captureMessageText,
  textFromAgentMessages,
  extractAgentEndError,
  extractModelError,
  trailingModelError,
  resolveFinalText,
  parseRetryAfter,
  describeProviderError,
  formatRetryNotice,
  formatDuration,
  formatShortDuration,
  defaultDisplayNameFor,
  formatLocalTime,
  sanitizeInstanceIdSegment,
  createInstanceId,
  instanceIdForRemoteCreate,
  migrateInstanceId,
  appendCapped,
  formatShellResult,
  execShellCommand,
  SHELL_MAX_OUTPUT_CHARS,
  SHELL_TIMEOUT_MS,
  MAX_AUTO_RETRY_MS,
  MAX_RETRY_ATTEMPTS,
  WS_BACKSTOP_POLL_MS,
  CLAIM_TTL_SECONDS,
  beginPendingInvocation,
  clearPendingForTesting: () => {
    releaseAllObservations()
    clearContributorTerminalWrites()
    primaryCompletionCommitted = false
    pending = undefined
    steeredInvocations = []
    reconnectPending = false
    claimIfIdleInFlight = undefined
    claimIfIdleRerunRequested = false
    sessionLifecycleGeneration++
    sessionTearingDown = false
  },
  NO_SOCKET_POLL_CAP_MS,
  nextQuietPollMs,
  completeInvocationWithMarkdown,
  claimNextInvocation,
  claimIfIdle,
  runReconnectCommand,
  runClearCommand,
  runSpawnCommand,
  runDoneCommand,
  runReloadCommand,
  scheduleRecoveredCompletion,
  runKeyCommand,
  reconnectPending: () => reconnectPending,
  HARNESS_HANDOFF_FALLBACK_MS,
  reloadPending: () => reloadPending,
  sessionLifecycleGeneration: () => sessionLifecycleGeneration,
  sessionTearingDown: () => sessionTearingDown,
  teardownTransport,
  resetQuietPollsForTesting: () => {
    consecutiveQuietPolls = 0
  },
  handleTransportDisconnected,
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(RELOAD_HANDOFF_COMMAND, {
    description: "Complete a Threa reload handoff",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload()
      } finally {
        reloadPending = false
      }
    },
  })

  pi.registerCommand("remote-control", {
    description:
      "Link this Pi session to a Threa scratchpad: configure | status | open | rename <name> | on | off | debug | debug-polls [on|off]",
    handler: async (args, ctx) => {
      if (ctx.mode === "print" || ctx.mode === "json") return
      const trimmedArgs = args.trim()
      const commandMatch = trimmedArgs.match(/^(\S+)(?:\s+([\s\S]*))?$/)
      const command = commandMatch?.[1]?.toLowerCase() ?? ""
      const commandArgs = commandMatch?.[2] ?? ""
      if (command === "configure" || command === "config") {
        await configureRemote(ctx, commandArgs)
        return
      }

      config = readConfig()
      if (!config) {
        ctx.ui.notify(`Missing ${CONFIG_PATH}. Run /remote-control configure to paste setup JSON.`, "warning")
        return
      }
      if (command === "off" || command === "disable") {
        await disableRemote(ctx)
        return
      }
      if (command === "on" || command === "enable") {
        await enableRemote(pi, ctx)
        return
      }
      if (command === "open") {
        const link = getCurrentSessionLink(ctx)
        if (!link) {
          ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
          return
        }
        const url = buildScratchpadUrl(config.baseUrl, config.workspaceId, link.activeStreamId)
        try {
          await openExternalUrl(url)
          ctx.ui.notify(`Opening Threa scratchpad: ${url}`, "info")
        } catch (error) {
          ctx.ui.notify(`Could not open Threa scratchpad: ${String(error)}\n${url}`, "error")
        }
        return
      }
      if (command === "debug-polls") {
        const enabled = commandArgs.trim().toLowerCase() !== "off"
        if (!setPollDebug(ctx, enabled)) {
          ctx.ui.notify("No Threa remote session is linked here. Run /remote-control first.", "warning")
          return
        }
        ctx.ui.notify(`Threa remote poll debug ${enabled ? "enabled" : "disabled"} for this Pi session`, "info")
        return
      }
      if (command === "status" || command === "debug") {
        const link = getCurrentSessionLink(ctx)
        const state = link?.enabled === true ? "on" : "off"
        const linked = link ? `linked to ${link.streamUrlPath}` : "not linked"
        const principal = command === "debug" ? await fetchBotPrincipal().catch(() => null) : null
        const details =
          command === "debug" && config
            ? [
                `session=${getRuntimeSessionId(ctx)}`,
                `instance=${link ? getSessionInstanceId(ctx) : (config.instanceId ?? "<unset>")}`,
                `legacyInstance=${config.instanceId ?? "<unset>"}`,
                `workspace=${config.workspaceId}`,
                `stream=${link?.activeStreamId ?? "<none>"}`,
                ...botTraitDiagnostics(principal),
                `debugPolling=${link?.debugPolling === true ? "on" : "off"}`,
                `pending=${pending?.id ?? "<none>"}`,
                `steered=${steeredInvocations.length}`,
                `lastPoll=${lastPollDebugSummary ?? "<none>"}`,
                `lastFailure=${lastPollFailureSummary ?? "<none>"}`,
                `ws=${transport?.socketConnected ? "connected" : transport ? "disconnected" : "<off>"}`,
                `wsCursor=${link?.wsCursor ?? "<none>"}`,
              ].join("\n")
            : ""
        ctx.ui.notify(
          `Threa remote is ${state} for this Pi session (${linked})${pending ? `; running ${pending.id}` : ""}${
            details ? `\n${details}` : ""
          }`,
          "info"
        )
        return
      }
      if (command === "rename") {
        const newName = commandArgs.trim()
        if (!newName) {
          ctx.ui.notify("Usage: `/remote-control rename <new name>`", "warning")
          return
        }
        await renameRemoteSession(ctx, newName)
        return
      }
      // Once a session is linked, a bare display-name argument is ambiguous —
      // it could mean "re-link to a fresh scratchpad" or "rename the existing
      // one". Force the user to be explicit: `rename` mutates the current
      // scratchpad, `off` first then `/remote-control "Name"` creates a new one.
      const existingLink = getCurrentSessionLink(ctx)
      if (existingLink) {
        if (trimmedArgs === "") {
          // Bare `/remote-control` with no args is idempotent: if this Pi
          // session is already linked, report status instead of POSTing to
          // /sessions, which would clobber the local link with a fresh
          // scratchpad. An instanceId migration (or any change that makes the
          // server's existing-link lookup miss) used to silently mint a new
          // scratchpad here.
          ctx.ui.notify(
            `Threa remote already linked for this Pi session (${existingLink.enabled ? "on" : "off"}). Run \`/remote-control status\` for details or \`/remote-control open\` to open the scratchpad.`,
            "info"
          )
          return
        }
        ctx.ui.notify(
          "Threa remote is already linked for this Pi session. Use `/remote-control rename <name>` to rename the scratchpad, or `/remote-control off` first to relink.",
          "warning"
        )
        return
      }
      await createRemoteSession(ctx, trimmedArgs)
      if (!(await verifySupervisedRevival(ctx))) {
        setRemoteStatus(ctx, "Threa remote: revival blocked")
        return
      }
      // Backstop before dial, matching session_start.
      startPolling(pi, ctx)
      await ensureTransport(pi, ctx)?.connect()
    },
  })

  pi.on("session_start", async (event, ctx) => {
    if (!config) config = readConfig()
    if (!config || !shouldHandleSessionEvents(ctx)) return
    sessionLifecycleGeneration++
    reconnectPending = false
    reloadPending = false
    sessionTearingDown = false
    if (!isCurrentSessionEnabled(ctx)) {
      setRemoteStatus(ctx, getCurrentSessionLink(ctx) ? "Threa remote: off" : "Threa remote: not linked")
      return
    }
    await tryRebindLegacySessionInstance(ctx)
    if (!(await verifySupervisedRevival(ctx))) {
      setRemoteStatus(ctx, "Threa remote: revival blocked")
      return
    }
    lastBusyHeartbeatAt = 0
    ensureTransport(pi, ctx)
    if (event.reason === "reload") {
      try {
        await restorePendingAfterReload(pi, ctx)
      } catch (error) {
        discardRestoredPending(ctx)
        ctx.ui.notify(`Threa reload claim recovery failed: ${summarizeError(error)}`, "warning")
      }
    } else {
      clearPendingSnapshot(ctx)
    }
    await heartbeat(pending ? "busy" : "available", pending ? "Working on Threa invocation…" : undefined, ctx).catch(
      (error) => emitPollDebug(ctx, `session startup heartbeat failed; continuing: ${summarizeError(error)}`)
    )
    // Polling FIRST: it is the backstop, and its first tick self-heals the
    // socket, so a dial that stalls or throws must not be able to take it down
    // with it. Sequencing the dial ahead of the loop did exactly that on
    // 2026-08-10 — session_start hung inside connect() and the runtime froze at
    // one startup heartbeat, footer still "linked".
    startPolling(pi, ctx)
    // The shutdown hook wrote "reloading…", and nothing else rewrites the
    // footer until the next invocation runs — so without this a healthy,
    // polling runtime advertises a reload that finished long ago. "linked"
    // means the session link, not the socket, so it goes before the dial.
    setRemoteStatus(ctx, pending ? `Threa remote: running ${pending.id}` : "Threa remote: linked")
    await ensureTransport(pi, ctx)?.connect()
    if (event.reason === "reload") ctx.ui.notify("Threa remote reconnected after reload.", "info")
  })

  pi.on("turn_start", async () => {
    activatePendingOutput()
  })

  pi.on("agent_start", async (_event, ctx) => {
    if (!config || !shouldHandleSessionEvents(ctx)) return
    await heartbeatBusyIfStale("Thinking…", ctx).catch(() => undefined)
    // Just a live status heartbeat — no `thinking` trace step. The model's
    // real narration lands as `thinking` trace steps from `message_end` below,
    // so a placeholder "Thinking…" row here would only add noise to the trace.
    await traceHeartbeat("Thinking…", ctx)
  })

  pi.on("tool_call", async (event, ctx) => {
    const output = currentPendingOutput()
    if (!output || !shouldHandleSessionEvents(ctx)) return
    const description = describeToolCall(event)
    const traceMode = traceModeForInvocation(output.invocation)
    output.toolCalls.set(event.toolCallId, { headline: toolTraceHeadline(event, traceMode) })
    await recordTraceStep("tool_call", formatToolCallTrace(event, traceMode), description)
  })

  pi.on("tool_result", async (event, ctx) => {
    const output = currentPendingOutput()
    if (!output || !shouldHandleSessionEvents(ctx)) return
    await recordTraceStep(
      event.isError ? "tool_error" : "tool_call",
      formatToolResultTrace(event, traceModeForInvocation(output.invocation), output.toolCalls),
      event.isError ? `${event.toolName} failed` : `Finished ${event.toolName}`
    )
    output.toolCalls.delete(event.toolCallId)
  })

  pi.on("tool_execution_end", async (event, ctx) => {
    const output = currentPendingOutput()
    if (!output || !shouldHandleSessionEvents(ctx) || !event.isError || !output.toolCalls.has(event.toolCallId)) return
    await traceHeartbeat(`${event.toolName} failed`, ctx, "tool_error")
    output.toolCalls.delete(event.toolCallId)
  })

  pi.on("message_start", async (event, ctx) => {
    if (!currentPendingOutput() || !shouldHandleSessionEvents(ctx) || event.message.role !== "assistant") return
    await traceHeartbeat("Composing response…", ctx)
  })

  pi.on("message_end", async (event, ctx) => {
    const output = currentPendingOutput()
    if (!output || !shouldHandleSessionEvents(ctx)) return
    const modelError = extractModelError(event.message)
    if (modelError) {
      output.modelError = modelError
      await recordTraceStep("tool_error", modelError, "Model call failed")
      return
    }
    const captured = captureMessageText(event.message)
    if (!captured) return
    if (captured.role === "assistant") {
      // A successful assistant message after an errored one means the retry
      // recovered — the earlier error is history, not the turn's outcome.
      output.modelError = undefined
      output.assistantTexts.push(captured.text)
      // Surface the model's running narration as a `thinking` trace step so
      // the scratchpad trace shows what the agent reasoned between tool
      // calls — not just a placeholder "Thinking…". The final assistant
      // message is reused as the posted reply (see `resolveFinalText`); we
      // skip re-recording it as `message_sent` at `agent_end` to avoid a
      // duplicate trace entry.
      await recordTraceStep("thinking", sanitizeTraceText(captured.text), "Thinking…")
    } else {
      output.nonAssistantTexts.push(captured)
    }
  })

  pi.on("after_provider_response", async (event, ctx) => {
    const output = currentPendingOutput()
    if (!output || !shouldHandleSessionEvents(ctx)) return
    const raw = event as { status?: unknown; headers?: unknown }
    const status = typeof raw.status === "number" ? raw.status : 0
    if (status < 400) return
    output.providerError = describeProviderError(status, raw.headers)
    const retryAfterMs = parseRetryAfter(raw.headers)
    output.retryAfterMs =
      status === 429 && retryAfterMs !== undefined && retryAfterMs <= MAX_AUTO_RETRY_MS ? retryAfterMs : undefined
  })

  pi.on("agent_end", async (event, ctx) => {
    if (!shouldHandleSessionEvents(ctx) || sessionTearingDown) return
    if (!pending) {
      if (config && isEnabled(ctx)) {
        lastBusyHeartbeatAt = 0
        await heartbeat("available", undefined, ctx).catch(() => undefined)
      }
      return
    }
    if (isWaitingForRetry) return
    // pi-agent-core returns from the loop without another turn_start when the
    // assistant message a queued steer sits behind stops with error or abort,
    // so a sent steer settles on this agent_end or the claim renews forever.
    if (awaitingTurnStart && ![...observedInvocations.values()].some((item) => item.updateInProgress)) {
      activatePendingOutput()
    }
    const output = currentPendingOutput()
    if (!output) return
    const expectedInvocation = output.invocation
    const expectedRevision = output.revision
    const expectedEpoch = output.epoch
    const settlement = (async () => {
      const isExpected = () =>
        activeOutputState === output &&
        pending === expectedInvocation &&
        expectedInvocation.sourceRevision === expectedRevision &&
        promptEpoch === expectedEpoch &&
        !cancelledInvocations.has(expectedInvocation)
      if (!isExpected()) return
      if (output.retryAfterMs !== undefined && output.assistantTexts.length === 0) {
        const attempt = (pendingRetry?.attempts ?? 0) + 1
        if (attempt <= MAX_RETRY_ATTEMPTS) {
          await scheduleProviderRetry(pi, ctx, output.retryAfterMs, attempt)
          return
        }
      }
      try {
        const finalText = resolveFinalText(event, {
          assistantTexts: output.assistantTexts,
          otherTexts: output.nonAssistantTexts,
          providerError: output.providerError,
          modelError: output.modelError,
        })
        // When the reply is the model's final assistant message, it was already
        // recorded as the last `thinking` trace step in `message_end` — recording
        // a `message_sent` step too would duplicate it in the trace dialog. Only
        // record `message_sent` for the fallback paths (provider error, event
        // error, non-assistant text) where there is no preceding thinking step.
        if (output.assistantTexts.length === 0) {
          const traceFinalText = extractAttachmentDirectives(finalText).markdown || NO_RESPONSE_MARKER
          await recordTraceStep(
            "message_sent",
            `Final response:\n\n${sanitizeTraceText(traceFinalText)}`,
            "Sent response"
          )
        }
        if (!isExpected()) return
        await completePending(finalText, ctx, {
          invocation: expectedInvocation,
          revision: expectedRevision,
          epoch: expectedEpoch,
        })
        setRemoteStatus(ctx, primaryCompletionCommitted ? "Threa remote: closing contributors" : "Threa remote: linked")
      } catch (error) {
        if (error instanceof ThreaApiError && error.status === 409 && error.code === "INVOCATION_INPUT_STALE") {
          releaseAllObservations()
          clearTurnState(ctx)
          scheduleClaimDrain(pi, ctx)
          return
        }
        ctx.ui.notify(`Failed to complete Threa invocation: ${String(error)}`, "warning")
        await failPending(error, ctx)
      }
    })()
    pendingSettlement = settlement
    try {
      await settlement
    } finally {
      if (pendingSettlement === settlement) pendingSettlement = undefined
    }
  })

  pi.on("agent_settled", async (_event, ctx) => {
    if (!config || !isEnabled(ctx) || !shouldHandleSessionEvents(ctx)) return
    await claimIfIdle(pi, ctx).catch((error) => {
      ctx.ui.notify(`Threa remote claim failed: ${String(error)}`, "warning")
    })
  })

  pi.on("session_shutdown", async (event, ctx) => {
    // In-process Pi child sessions can discover this global extension. Never
    // let an unlinked child tear down or complete the linked parent's claim.
    if (!shouldHandleSessionEvents(ctx)) return
    sessionTearingDown = true
    sessionLifecycleGeneration++
    claimIfIdleRerunRequested = false
    reconnectPending = false
    stopPolling()
    releaseAllObservations()
    cancelPendingRetryTimer()
    clearRecoveredCompletionTimer()
    await claimIfIdleInFlight?.catch(() => undefined)
    await pendingSettlement?.catch(() => undefined)
    if (event.reason === "reload" && config && isEnabled(ctx)) {
      if (pending) savePendingSnapshot(ctx)
      else clearPendingSnapshot(ctx)
    }
    teardownTransport()
    if (event.reason === "reload" && config && isEnabled(ctx)) {
      setRemoteStatus(ctx, "Threa remote: reloading…")
      await heartbeat("offline", undefined, ctx).catch(() => undefined)
      return
    }
    await failPending("Pi session shut down", ctx)
    await heartbeat("offline", undefined, ctx).catch(() => undefined)
    ctx.ui.setStatus(STATUS_KEY, undefined)
  })
}
