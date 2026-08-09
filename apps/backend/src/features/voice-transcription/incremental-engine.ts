import { ulid } from "ulid"
import type { JSONContent, VoiceReplacementAckStatus } from "@threa/types"
import {
  VOICE_POLISH_WINDOW_MAX_CHARS,
  VOICE_POLISH_WINDOW_MAX_FINALS,
  VOICE_POLISH_READ_ONLY_SUFFIX_MAX_CHARS,
  VOICE_POLISH_WIDEN_MAX_WINDOWS,
} from "./config"

export interface AcceptedWindowResult {
  operationId: string
  resultChunkId: string
  throughRevision: number
  markdown: string
  contentJson: JSONContent
  rawMarkdown: string
  rawContentJson: JSONContent
}

export interface VoicePolishWindow {
  chunkId: string
  predecessorChunkId?: string
  predecessorSeparator: "" | " "
  firstRevision: number
  latestRevision: number
  rawParts: string[]
  rawCharCount: number
  finalCount: number
  state: "open" | "sealed"
  logicalSpanCount: number
  accepted?: AcceptedWindowResult
}

export interface RawWindowDelta {
  chunkId: string
  afterChunkId?: string
  revision: number
  text: string
  joinPrevious?: boolean
  window: VoicePolishWindow
}

interface PendingAcceptance {
  operationId: string
  sources: Array<{ chunkId: string; throughRevision: number }>
  result: AcceptedWindowResult
}

export class IncrementalVoiceEngine {
  readonly windows: VoicePolishWindow[] = []
  revision = 0
  private pending = new Map<string, PendingAcceptance>()
  private acknowledged = new Set<string>()
  readonly counters = {
    operations: 0,
    applied: 0,
    timeout: 0,
    stale: 0,
    locked: 0,
    missing: 0,
    non_contiguous: 0,
    invalid: 0,
  }
  maxMutableLength = 0

  appendFinal(text: string): RawWindowDelta[] {
    const pieces = splitUnicodeFinal(text, VOICE_POLISH_WINDOW_MAX_CHARS)
    const deltas: RawWindowDelta[] = []
    for (const [index, piece] of pieces.entries()) {
      const priorPiece = pieces[index - 1]
      const joinPrevious = index > 0 && priorPiece !== undefined && !/\s$/u.test(priorPiece) && !/^\s/u.test(piece)
      deltas.push(this.appendPiece(piece, index === 0, joinPrevious))
    }
    return deltas
  }

  get activeWindow(): VoicePolishWindow | undefined {
    return this.windows.at(-1)
  }

  raw(window: VoicePolishWindow): string {
    return window.rawParts.join("")
  }

  isExactlyAccepted(window: VoicePolishWindow): boolean {
    return window.accepted?.throughRevision === window.latestRevision
  }

  visibleMarkdown(window: VoicePolishWindow): string {
    const raw = this.raw(window)
    const accepted = window.accepted
    if (!accepted) return raw
    if (accepted.throughRevision === window.latestRevision) return accepted.markdown
    return raw.startsWith(accepted.rawMarkdown) ? `${accepted.markdown}${raw.slice(accepted.rawMarkdown.length)}` : raw
  }

  registerOperation(args: {
    operationId: string
    sources: Array<{ chunkId: string; throughRevision: number }>
    resultChunkId: string
    markdown: string
    contentJson: JSONContent
    rawMarkdown: string
    rawContentJson: JSONContent
  }): boolean {
    if (this.pending.has(args.operationId) || this.acknowledged.has(args.operationId)) return false
    if (!this.sourcesExact(args.sources)) return false
    this.counters.operations++
    this.maxMutableLength = Math.max(this.maxMutableLength, scalarLength(args.rawMarkdown))
    this.pending.set(args.operationId, {
      operationId: args.operationId,
      sources: args.sources,
      result: {
        operationId: args.operationId,
        resultChunkId: args.resultChunkId,
        throughRevision: Math.max(...args.sources.map((source) => source.throughRevision)),
        markdown: args.markdown,
        contentJson: args.contentJson,
        rawMarkdown: args.rawMarkdown,
        rawContentJson: args.rawContentJson,
      },
    })
    return true
  }

  rejectPending(operationId: string, status: "timeout" = "timeout"): boolean {
    const rejected = this.pending.delete(operationId)
    if (rejected) this.counters[status]++
    return rejected
  }

  acknowledge(operationId: string, status: VoiceReplacementAckStatus): boolean {
    if (this.acknowledged.has(operationId)) return false
    const pending = this.pending.get(operationId)
    if (!pending) return false
    this.pending.delete(operationId)
    this.acknowledged.add(operationId)
    if (status !== "applied") {
      this.counters[status]++
      return false
    }
    const sourceIndexes = this.sourceIndexesAtOrAfter(pending.sources)
    if (!sourceIndexes) {
      this.counters.stale++
      return false
    }
    this.counters.applied++
    const targetIndex = sourceIndexes.at(-1)!
    if (pending.sources.length === 1) {
      this.windows[targetIndex]!.accepted = pending.result
      return true
    }

    const firstIndex = sourceIndexes[0]!
    const sources = this.windows.slice(firstIndex, targetIndex + 1)
    const collapsedRaw = sources
      .map((source, index) => `${index > 0 ? source.predecessorSeparator : ""}${this.raw(source)}`)
      .join("")
    const collapsed: VoicePolishWindow = {
      chunkId: pending.result.resultChunkId,
      predecessorChunkId: sources[0]!.predecessorChunkId,
      predecessorSeparator: sources[0]!.predecessorSeparator,
      firstRevision: sources[0]!.firstRevision,
      latestRevision: Math.max(...sources.map((source) => source.latestRevision)),
      rawParts: [collapsedRaw],
      rawCharCount: scalarLength(collapsedRaw),
      finalCount: sources.reduce((sum, source) => sum + source.finalCount, 0),
      state: "sealed",
      logicalSpanCount: Math.min(
        VOICE_POLISH_WIDEN_MAX_WINDOWS,
        sources.reduce((sum, source) => sum + source.logicalSpanCount, 0)
      ),
      accepted: pending.result,
    }
    this.windows.splice(firstIndex, sources.length, collapsed)
    for (let index = firstIndex + 1; index < this.windows.length; index++) {
      if (this.windows[index]!.predecessorChunkId === sources.at(-1)!.chunkId)
        this.windows[index]!.predecessorChunkId = collapsed.chunkId
    }
    return true
  }

  exactCurrentAccepted(): AcceptedWindowResult | undefined {
    const current = this.activeWindow
    return current && this.isExactlyAccepted(current) ? current.accepted : undefined
  }

  immediateAcceptedPredecessor(window = this.activeWindow): VoicePolishWindow | undefined {
    if (!window?.predecessorChunkId) return undefined
    const predecessor = this.windows.find((candidate) => candidate.chunkId === window.predecessorChunkId)
    return predecessor && this.isExactlyAccepted(predecessor) ? predecessor : undefined
  }

  olderAcceptedSuffix(window = this.activeWindow): string {
    const predecessor = this.immediateAcceptedPredecessor(window)
    const older = this.windows
      .filter((candidate) => candidate !== predecessor && candidate !== window && candidate.accepted)
      .map((candidate) => candidate.accepted!.markdown)
      .join("\n\n")
    return takeLastScalars(older, VOICE_POLISH_READ_ONLY_SUFFIX_MAX_CHARS)
  }

  private appendPiece(piece: string, newFinal: boolean, joinPrevious: boolean): RawWindowDelta {
    let window = this.activeWindow
    const separator = newFinal && window?.rawParts.length ? " " : ""
    const addedChars = scalarLength(separator + piece)
    if (
      !window ||
      window.state === "sealed" ||
      window.finalCount + (newFinal ? 1 : 0) > VOICE_POLISH_WINDOW_MAX_FINALS ||
      window.rawCharCount + addedChars > VOICE_POLISH_WINDOW_MAX_CHARS
    ) {
      if (window) window.state = "sealed"
      const predecessorSeparator = window && newFinal ? " " : ""
      window = {
        chunkId: ulid(),
        predecessorChunkId: window?.chunkId,
        predecessorSeparator,
        firstRevision: this.revision + 1,
        latestRevision: this.revision + 1,
        rawParts: [],
        rawCharCount: 0,
        finalCount: 0,
        state: "open",
        logicalSpanCount: 1,
      }
      this.windows.push(window)
    }
    const prefix = newFinal && window.rawParts.length ? " " : ""
    window.rawParts.push(prefix + piece)
    window.rawCharCount += scalarLength(prefix + piece)
    this.maxMutableLength = Math.max(this.maxMutableLength, window.rawCharCount)
    if (newFinal || window.finalCount === 0) window.finalCount++
    window.latestRevision = ++this.revision
    return {
      chunkId: window.chunkId,
      afterChunkId: window.rawParts.length === 1 ? window.predecessorChunkId : undefined,
      revision: this.revision,
      text: piece,
      ...(joinPrevious ? { joinPrevious: true } : {}),
      window,
    }
  }

  private sourcesExact(sources: Array<{ chunkId: string; throughRevision: number }>): boolean {
    const indices = this.sourceIndexesAtOrAfter(sources)
    return Boolean(
      indices &&
      sources.every((source, index) => this.windows[indices[index]!]!.latestRevision === source.throughRevision)
    )
  }

  private sourceIndexesAtOrAfter(sources: Array<{ chunkId: string; throughRevision: number }>): number[] | undefined {
    if (sources.length < 1 || sources.length > VOICE_POLISH_WIDEN_MAX_WINDOWS) return undefined
    const indices = sources.map((source) =>
      this.windows.findIndex(
        (window) => window.chunkId === source.chunkId && window.latestRevision >= source.throughRevision
      )
    )
    if (indices.some((index) => index < 0)) return undefined
    if (indices.some((index, position) => position > 0 && index !== indices[position - 1]! + 1)) return undefined
    return indices
  }
}

export function scalarLength(value: string): number {
  return Array.from(value).length
}

export function takeLastScalars(value: string, maximum: number): string {
  return Array.from(value).slice(-maximum).join("")
}

export function splitUnicodeFinal(value: string, maximum: number): string[] {
  if (maximum < 1) throw new RangeError("maximum must be positive")
  const scalars = Array.from(value)
  const pieces: string[] = []
  let offset = 0
  while (offset < scalars.length) {
    const end = Math.min(offset + maximum, scalars.length)
    if (end === scalars.length) {
      pieces.push(scalars.slice(offset).join(""))
      break
    }
    let split = end
    for (let index = end - 1; index >= offset; index--) {
      if (/^\s$/u.test(scalars[index]!)) {
        split = index + 1
        break
      }
    }
    pieces.push(scalars.slice(offset, split).join(""))
    offset = split
  }
  return pieces
}
