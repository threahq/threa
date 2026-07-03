import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

/**
 * Trace steps for a Claude Code turn, sourced from the session transcript.
 *
 * Claude Code appends every event of a session — thinking blocks, tool calls,
 * tool results, assistant text — as one JSON line to
 * `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. Tailing that file gives
 * a structured, terminal-free view of what the session is doing, which this
 * module maps to Threa trace steps and ships through the SDK's `recordSteps`
 * (over the /bot socket) while a turn is in flight.
 *
 * Privacy model (mirrors pi-remote's, one notch stricter): in the default
 * `headline` mode nothing user-generated leaves the machine — tool calls ship
 * a category headline plus at most a file *basename*; shell commands, file
 * contents, tool outputs, and thinking bodies are replaced with "omitted for
 * safety" markers carrying only size telemetry. Thinking is withheld entirely
 * (pi ships its narration because pi's narration is stream-bound anyway;
 * Claude's thinking is internal and can quote file contents wholesale). The
 * `full` mode exists for E2EE-backed session links, where complete steps can
 * ship encrypted — nothing wires it up until then.
 */

// Wire format shared with pi-remote and parsed by the frontend trace dialog
// (`apps/frontend/src/components/trace/trace-step.tsx`; canonical constants in
// `packages/types`). Duplicated here for the same reason pi-remote duplicates
// it: this package installs standalone (install-local vendoring), so it cannot
// depend on @threa/types.
const TOOL_TRACE_FORMAT = "pi_tool_trace"
const SECTION_LABELS = {
  ARGUMENTS: "Arguments",
  OUTPUT: "Output",
  ERROR_OUTPUT: "Error output",
  DETAILS: "Details",
} as const
type SectionLabel = (typeof SECTION_LABELS)[keyof typeof SECTION_LABELS]

const TRACE_CONTENT_MAX_CHARS = 9_500
const DEFAULT_POLL_MS = 500
const DEFAULT_BIND_TIMEOUT_MS = 60_000
const DEFAULT_MAX_FRAMES_PER_TURN = 400
// While unbound, appended text is buffered per candidate so the whole turn can
// be replayed once the right file identifies itself. Turn prefixes are small;
// the cap only guards against a runaway writer in a candidate we never bind.
const MAX_UNBOUND_BUFFER_CHARS = 4_000_000
const MAX_LINE_CHARS = 2_000_000
// Only the most recently touched transcripts are worth watching — a project
// dir accumulates every historical session, and dead files never append.
const MAX_CANDIDATES = 12

export type RedactionMode = "headline" | "full"

export interface TraceFrame {
  stepType: string
  content: string
}

export interface MappedStep extends TraceFrame {
  /** Presence status line for the strip (already from the fixed allowlist below — never free text). */
  statusText: string
}

export interface MapContext {
  mode: RedactionMode
  /**
   * tool_use id → headline, so a result renders under the same headline as its
   * call. An empty-string sentinel marks a call whose result must be skipped
   * (the channel's own send/reply tools).
   */
  toolHeadlines: Map<string, string>
}

/** Claude Code's project-dir encoding: every non-alphanumeric character becomes '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isSensitivePath(path: unknown): boolean {
  if (typeof path !== "string") return false
  return /(^|[\\/.])(?:env|npmrc|netrc|pypirc|pgpass|aws|credentials|config|secrets?|tokens?|keys?)(?:$|[.\\/-])/i.test(
    path
  )
}

function safeFileSummary(path: unknown): string {
  if (isSensitivePath(path)) return "sensitive file"
  const name = typeof path === "string" && path.trim() ? basename(path.trim()) : ""
  return name ? `file ${name}` : "file"
}

function safeToolName(toolName: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(toolName) ? toolName : "tool"
}

function truncateForTrace(text: string, max = TRACE_CONTENT_MAX_CHARS): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max).trimEnd()}\n\n…[truncated; ${omitted} more characters]`
}

/**
 * Serialize a structured tool trace under the content budget, trimming the
 * largest section first (ported from pi-remote so both runtimes emit the same
 * shape the trace dialog parses).
 */
function formatStructuredToolTrace(params: {
  headline: string
  sections: Array<{ label: SectionLabel; body: string; lang: string | null }>
}): string {
  const sections = params.sections.map((section) => ({ ...section, originalBody: section.body }))

  for (let attempt = 0; attempt < 24; attempt++) {
    const payload = JSON.stringify({
      format: TOOL_TRACE_FORMAT,
      headline: params.headline,
      sections: sections.map(({ originalBody: _originalBody, ...section }) => section),
    })
    if (payload.length <= TRACE_CONTENT_MAX_CHARS) return payload

    const largestIndex = sections.reduce(
      (largest, section, index) => (section.body.length > sections[largest]!.body.length ? index : largest),
      0
    )
    const largest = sections[largestIndex]
    if (!largest || largest.originalBody.length === 0) break

    const overflow = payload.length - TRACE_CONTENT_MAX_CHARS
    const currentVisibleLength = largest.body.includes("…[section truncated;")
      ? largest.body.indexOf("\n\n…[section truncated;")
      : largest.body.length
    const nextVisibleLength = Math.max(0, currentVisibleLength - Math.max(overflow + 256, 512))
    const omitted = largest.originalBody.length - nextVisibleLength
    largest.body = `${largest.originalBody.slice(0, nextVisibleLength).trimEnd()}\n\n…[section truncated; ${omitted} more characters]`
  }

  return JSON.stringify({
    format: TOOL_TRACE_FORMAT,
    headline: params.headline,
    sections: [{ label: SECTION_LABELS.DETAILS, body: "Trace content was too large to serialize safely.", lang: null }],
  })
}

function toolInputPath(input: unknown): unknown {
  if (!isObject(input)) return undefined
  return input.file_path ?? input.path ?? input.notebook_path
}

export function describeClaudeTool(name: string, input: unknown): { headline: string; statusText: string } {
  const lower = name.toLowerCase()
  const path = toolInputPath(input)
  switch (lower) {
    case "bash":
      return { headline: "Running shell command", statusText: "Running shell command…" }
    case "read":
      if (isSensitivePath(path)) return { headline: "Reading sensitive file", statusText: "Reading sensitive file…" }
      return { headline: `Reading ${safeFileSummary(path)}`, statusText: "Reading file…" }
    case "write":
      return { headline: `Writing ${safeFileSummary(path)}`, statusText: "Writing file…" }
    case "edit":
    case "notebookedit":
      return { headline: `Editing ${safeFileSummary(path)}`, statusText: "Editing file…" }
    case "grep":
    case "glob":
      return { headline: "Searching files", statusText: "Searching files…" }
    case "task":
    case "agent":
      return { headline: "Delegating to a subagent", statusText: "Using tool…" }
    case "webfetch":
      return { headline: "Fetching a web page", statusText: "Using tool…" }
    case "websearch":
      return { headline: "Searching the web", statusText: "Using tool…" }
    case "todowrite":
    case "taskcreate":
    case "taskupdate":
      return { headline: "Updating the task list", statusText: "Using tool…" }
    default: {
      const mcp = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(name)
      if (mcp) return { headline: `Using ${mcp[1]}:${mcp[2]}`, statusText: "Using tool…" }
      return { headline: `Using ${safeToolName(name)}`, statusText: "Using tool…" }
    }
  }
}

function safeToolArgumentSummary(name: string, input: unknown): string {
  const lower = name.toLowerCase()
  if (lower === "bash") return "Shell command omitted for safety."
  if (lower === "read" || lower === "write" || lower === "edit" || lower === "notebookedit") {
    const action = lower === "read" ? "Read" : lower === "write" ? "Write" : "Edit"
    return `${action} target: ${safeFileSummary(toolInputPath(input))}. File contents and patches omitted for safety.`
  }
  if (lower === "grep" || lower === "glob") return "Search arguments omitted for safety."
  return `Arguments for ${safeToolName(name)} omitted for safety.`
}

function textFromToolResult(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!isObject(part) || !("type" in part)) return ""
      if (part.type === "text" && typeof part.text === "string") return part.text
      if (part.type === "image") return "[image output]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function summarizeToolOutput(output: string): string {
  const text = output.trim()
  if (!text) return "Tool produced no textual output."
  const lines = text.split("\n").length
  return `Tool output omitted for safety. Captured locally: ${text.length} characters across ${lines} ${lines === 1 ? "line" : "lines"}.`
}

function withheldBody(kind: "Thinking content" | "Assistant narration", length: number): string {
  return `${kind} omitted for safety. Captured locally: ${length} characters.`
}

/** The channel's own MCP tools — their payloads land in the stream as real messages, so trace rows would be noise. */
const OWN_TOOL_RE = /^mcp__threa__(send|reply)$/i

function toolUseStep(part: Record<string, unknown>, ctx: MapContext): MappedStep | null {
  const name = typeof part.name === "string" ? part.name : ""
  const id = typeof part.id === "string" ? part.id : ""
  if (!name) return null
  if (OWN_TOOL_RE.test(name)) {
    if (id) ctx.toolHeadlines.set(id, "")
    return null
  }
  const { headline, statusText } = describeClaudeTool(name, part.input)
  if (id) ctx.toolHeadlines.set(id, headline)
  const body =
    ctx.mode === "full"
      ? truncateForTrace(JSON.stringify(part.input ?? {}, null, 1))
      : safeToolArgumentSummary(name, part.input)
  return {
    stepType: "tool_call",
    content: formatStructuredToolTrace({
      headline,
      sections: [{ label: SECTION_LABELS.ARGUMENTS, body, lang: ctx.mode === "full" ? "json" : null }],
    }),
    statusText,
  }
}

function toolResultStep(part: Record<string, unknown>, ctx: MapContext): MappedStep | null {
  const id = typeof part.tool_use_id === "string" ? part.tool_use_id : ""
  const headline = ctx.toolHeadlines.get(id)
  ctx.toolHeadlines.delete(id)
  if (headline === "") return null
  const isError = part.is_error === true
  const output = textFromToolResult(part.content)
  const body =
    ctx.mode === "full"
      ? truncateForTrace(output.trim() || "(no textual output)")
      : `${summarizeToolOutput(output)}${isError ? " Error details omitted for safety." : ""}`
  return {
    stepType: isError ? "tool_error" : "tool_call",
    content: formatStructuredToolTrace({
      headline: headline ?? "Used tool",
      sections: [{ label: isError ? SECTION_LABELS.ERROR_OUTPUT : SECTION_LABELS.OUTPUT, body, lang: null }],
    }),
    statusText: isError ? "Tool failed" : "Tool finished",
  }
}

/**
 * Map one transcript JSONL line to trace steps. Unknown/irrelevant line types
 * (session metadata, snapshots, the echoed user prompt) map to nothing.
 */
export function mapTranscriptLine(raw: string, ctx: MapContext): MappedStep[] {
  if (raw.length === 0 || raw.length > MAX_LINE_CHARS) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isObject(parsed)) return []
  const type = parsed.type
  if (type !== "assistant" && type !== "user") return []
  const message = parsed.message
  if (!isObject(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []

  const steps: MappedStep[] = []
  for (const part of content) {
    if (!isObject(part)) continue
    if (type === "assistant" && part.type === "thinking" && typeof part.thinking === "string") {
      // Current Claude Code persists thinking blocks with an empty body (only
      // the opaque signature), so this usually skips — the branch matters for
      // transcripts that do carry bodies.
      const text = part.thinking.trim()
      if (!text) continue
      steps.push({
        stepType: "thinking",
        content: ctx.mode === "full" ? truncateForTrace(text) : withheldBody("Thinking content", text.length),
        statusText: "Thinking…",
      })
    } else if (type === "assistant" && part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim()
      if (!text) continue
      steps.push({
        stepType: "thinking",
        content: ctx.mode === "full" ? truncateForTrace(text) : withheldBody("Assistant narration", text.length),
        statusText: "Composing response…",
      })
    } else if (type === "assistant" && part.type === "tool_use") {
      const step = toolUseStep(part, ctx)
      if (step) steps.push(step)
    } else if (type === "user" && part.type === "tool_result") {
      const step = toolResultStep(part, ctx)
      if (step) steps.push(step)
    }
  }
  return steps
}

interface Candidate {
  path: string
  offset: number
  /** Partial trailing line carried between reads. */
  remainder: string
  /** Appended text accumulated while unbound, replayed on bind. */
  buffered: string
}

export interface TranscriptTracerOptions {
  /** Defaults to `~/.claude/projects`. */
  projectsRoot?: string
  /** Defaults to `process.cwd()`. */
  cwd?: string
  mode?: RedactionMode
  pollMs?: number
  bindTimeoutMs?: number
  maxFramesPerTurn?: number
  /**
   * Ship a batch of frames for the in-flight turn. Return false when the turn
   * is no longer open — the tracer stops tailing for it.
   */
  emit: (invocationId: string, frames: TraceFrame[], statusText?: string) => Promise<boolean>
  log?: (message: string) => void
}

/**
 * Tails the session transcript while a turn is in flight and ships mapped
 * steps through `emit`.
 *
 * Binding: a cwd's project dir can hold transcripts of several live sessions
 * (two Claude sessions in one directory is the known identity-collision case),
 * so newest-mtime is not trusted. Instead, every candidate is watched from the
 * turn-start offset, and the file that echoes the delivered turn's
 * invocation id — Claude Code writes the injected prompt into the transcript —
 * is bound for the tracer's lifetime. Until binding, nothing is emitted;
 * the bound file's buffered prefix is replayed so no step is lost.
 */
export class TranscriptTracer {
  private readonly projectDir: string
  private readonly mode: RedactionMode
  private readonly pollMs: number
  private readonly bindTimeoutMs: number
  private readonly maxFramesPerTurn: number
  private readonly emit: TranscriptTracerOptions["emit"]
  private readonly log: (message: string) => void

  private bound: Candidate | undefined
  private candidates: Candidate[] = []
  private turn: { invocationId: string; emitted: number; truncationNoted: boolean; bindDeadline: number } | undefined
  private readonly toolHeadlines = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private polling = false

  constructor(options: TranscriptTracerOptions) {
    const root = options.projectsRoot ?? join(homedir(), ".claude", "projects")
    this.projectDir = join(root, encodeProjectDir(options.cwd ?? process.cwd()))
    this.mode = options.mode ?? "headline"
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.bindTimeoutMs = options.bindTimeoutMs ?? DEFAULT_BIND_TIMEOUT_MS
    this.maxFramesPerTurn = options.maxFramesPerTurn ?? DEFAULT_MAX_FRAMES_PER_TURN
    this.emit = options.emit
    this.log = options.log ?? (() => undefined)
  }

  /** Start (or re-window) tailing for a delivered turn. Call BEFORE the turn content is pushed to the runtime. */
  beginTurn(invocationId: string): void {
    this.stopTimer()
    this.turn = { invocationId, emitted: 0, truncationNoted: false, bindDeadline: Date.now() + this.bindTimeoutMs }
    if (this.bound) {
      const fresh = this.snapshotCandidate(this.bound.path)
      if (fresh) {
        this.bound = fresh
      } else {
        // Bound file vanished (worktree cleanup, manual delete) — rebind.
        this.bound = undefined
      }
    }
    if (!this.bound) this.candidates = this.scanCandidates()
    this.schedule(this.pollMs)
  }

  /** The turn was answered; stop tailing (frames for a closed invocation are rejected server-side anyway). */
  endTurn(invocationId: string): void {
    if (this.turn?.invocationId !== invocationId) return
    this.turn = undefined
    this.stopTimer()
  }

  stop(): void {
    this.turn = undefined
    this.stopTimer()
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(delayMs: number): void {
    this.stopTimer()
    if (!this.turn) return
    this.timer = setTimeout(() => void this.poll(), delayMs)
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.turn) return
    this.polling = true
    try {
      if (this.bound) await this.drainBound()
      else await this.tryBind()
    } catch (error) {
      this.log(`transcript trace poll failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.polling = false
      this.schedule(this.pollMs)
    }
  }

  private async drainBound(): Promise<void> {
    const turn = this.turn
    const bound = this.bound
    if (!turn || !bound) return
    const lines = this.readLines(bound)
    if (lines.length === 0) return
    await this.emitLines(lines)
  }

  private async tryBind(): Promise<void> {
    const turn = this.turn
    if (!turn) return
    if (this.candidates.length === 0) this.candidates = this.scanCandidates()
    for (const candidate of this.candidates) {
      const appended = this.readAppended(candidate)
      if (appended) {
        candidate.buffered = (candidate.buffered + appended).slice(-MAX_UNBOUND_BUFFER_CHARS)
      }
      if (candidate.buffered.includes(turn.invocationId)) {
        this.bound = candidate
        this.candidates = []
        this.log(`transcript bound: ${basename(candidate.path)}`)
        // Replay the buffered prefix through the line splitter so the steps
        // that landed before binding are not lost.
        const replay = candidate.buffered
        candidate.buffered = ""
        const lines = this.splitLines(candidate, replay)
        if (lines.length > 0) await this.emitLines(lines)
        return
      }
    }
    if (Date.now() > turn.bindDeadline) {
      this.log(`transcript bind timed out for ${turn.invocationId} — tracing disabled for this turn`)
      this.turn = undefined
    }
  }

  private async emitLines(lines: string[]): Promise<void> {
    const turn = this.turn
    if (!turn) return
    const ctx: MapContext = { mode: this.mode, toolHeadlines: this.toolHeadlines }
    let frames: TraceFrame[] = []
    let statusText: string | undefined
    for (const line of lines) {
      for (const step of mapTranscriptLine(line, ctx)) {
        frames.push({ stepType: step.stepType, content: step.content })
        statusText = step.statusText
      }
    }
    if (frames.length === 0) return
    if (turn.emitted >= this.maxFramesPerTurn) {
      if (!turn.truncationNoted) {
        turn.truncationNoted = true
        frames = [
          {
            stepType: "thinking",
            content: "Trace truncated for this turn: further steps omitted (still captured locally).",
          },
        ]
      } else {
        return
      }
    } else if (turn.emitted + frames.length > this.maxFramesPerTurn) {
      frames = frames.slice(0, this.maxFramesPerTurn - turn.emitted)
    }
    turn.emitted += frames.length
    const open = await this.emit(turn.invocationId, frames, statusText)
    if (!open && this.turn?.invocationId === turn.invocationId) {
      // Turn closed server-side (reply landed, timeout, or supersede).
      this.turn = undefined
    }
  }

  private scanCandidates(): Candidate[] {
    let names: string[]
    try {
      names = readdirSync(this.projectDir)
    } catch {
      return []
    }
    // Subagent transcripts (agent-*.jsonl) narrate delegated work, not this
    // session's turn — the Task tool_use row already marks the delegation.
    const files = names.filter((name) => name.endsWith(".jsonl") && !name.startsWith("agent-"))
    const withMtime = files
      .map((name) => {
        const path = join(this.projectDir, name)
        try {
          const stats = statSync(path)
          return { path, mtimeMs: stats.mtimeMs, size: stats.size }
        } catch {
          return undefined
        }
      })
      .filter((entry): entry is { path: string; mtimeMs: number; size: number } => entry !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_CANDIDATES)
    return withMtime.map((entry) => ({ path: entry.path, offset: entry.size, remainder: "", buffered: "" }))
  }

  private snapshotCandidate(path: string): Candidate | undefined {
    try {
      const stats = statSync(path)
      return { path, offset: stats.size, remainder: "", buffered: "" }
    } catch {
      return undefined
    }
  }

  /** Read text appended since the candidate's offset. A shrunk file (rotation) resets the offset. */
  private readAppended(candidate: Candidate): string {
    let size: number
    try {
      size = statSync(candidate.path).size
    } catch {
      return ""
    }
    if (size < candidate.offset) candidate.offset = size
    if (size === candidate.offset) return ""
    let fd: number
    try {
      fd = openSync(candidate.path, "r")
    } catch {
      return ""
    }
    try {
      const length = Math.min(size - candidate.offset, 8_000_000)
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, candidate.offset)
      candidate.offset += read
      // A read can split a multibyte character at the boundary; the mangled
      // character lands inside a line whose body is redacted to a size anyway.
      return buffer.toString("utf8", 0, read)
    } finally {
      closeSync(fd)
    }
  }

  private readLines(candidate: Candidate): string[] {
    const appended = this.readAppended(candidate)
    if (!appended) return []
    return this.splitLines(candidate, appended)
  }

  /** Split appended text into complete lines, carrying a partial trailing line in the candidate's remainder. */
  private splitLines(candidate: Candidate, appended: string): string[] {
    const text = candidate.remainder + appended
    const parts = text.split("\n")
    candidate.remainder = parts.pop() ?? ""
    return parts.map((line) => line.trim()).filter((line) => line.length > 0)
  }
}
