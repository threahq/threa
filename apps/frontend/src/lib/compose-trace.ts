import { useCallback, useEffect, useMemo, useRef } from "react"
import type { ComposeTrace } from "@threa/types"
import { sequenceToNum } from "@/db"
import { getLatestPersistedSequence } from "@/sync/stream-sync"
import { useFeatureFlag } from "@/hooks/use-feature-flags"

/**
 * A compose session: the window between the author focusing an idle composer and
 * that composer's send landing in the queue. It records the causal horizon —
 * what had already synced when they started writing, and how far the stream had
 * moved by the time they sent — as weighted signal for a later classifier.
 *
 * `getLatestPersistedSequence` is the sequence source rather than a raw index
 * read: it already excludes optimistic rows (`_status == null`), so the author's
 * own in-flight sends never inflate the horizon.
 */
interface OpenSession {
  scopeId: string
  horizonStreamId: string
  openedAt: string
  openedAtSequence: number | null
  resumedDraft: boolean
}

type ReadLatestSequence = (streamId: string) => Promise<string | null>

export class ComposeTraceRecorder {
  private session: OpenSession | null = null

  constructor(private readLatestSequence: ReadLatestSequence = getLatestPersistedSequence) {}

  /**
   * Starts a session if none is open for `scopeId`. Focus fires on every click
   * and every tab back into the composer, so a session already open for this
   * scope is left alone — `openedAt` must be when the author STARTED writing,
   * not the last time the caret landed. A focus in a different scope replaces
   * the session outright: the previous composer's horizon says nothing about
   * this one.
   *
   * `horizonStreamId` is the stream both sequences are read from — the surface
   * the author was reading. It is NOT necessarily the stream the send lands in
   * (a board reply can route into another stream, or into a thread that does
   * not exist yet), so it travels on the trace rather than being inferred from
   * the message.
   */
  async open(scopeId: string, horizonStreamId: string, resumedDraft: boolean): Promise<void> {
    if (this.session?.scopeId === scopeId && this.session.horizonStreamId === horizonStreamId) return
    const openedAt = new Date().toISOString()
    const session: OpenSession = { scopeId, horizonStreamId, openedAt, openedAtSequence: null, resumedDraft }
    this.session = session
    const sequence = await this.readLatestSequence(horizonStreamId)
    // A focus in another scope (or a send) may have landed while the read was in
    // flight — only stamp the session this call actually started.
    if (this.session === session) session.openedAtSequence = toSequenceNumber(sequence)
  }

  /** Drops any open session — the composer's scope changed, so its horizon is stale. */
  reset(): void {
    this.session = null
  }

  /**
   * Closes the open session and returns its trace. Undefined when the author
   * never focused this composer (a programmatic or restored send), which is a
   * normal absence, not an error. The next focus starts a fresh session.
   *
   * Both sequences come from the session's own `horizonStreamId`, so a trace can
   * never mix two streams' numbering.
   */
  async take(): Promise<ComposeTrace | undefined> {
    const session = this.session
    if (!session) return undefined
    this.session = null
    const sentAtSequence = toSequenceNumber(await this.readLatestSequence(session.horizonStreamId))
    return {
      horizonStreamId: session.horizonStreamId,
      openedAt: session.openedAt,
      openedAtSequence: session.openedAtSequence,
      sentAtSequence,
      resumedDraft: session.resumedDraft,
    }
  }
}

function toSequenceNumber(sequence: string | null): number | null {
  if (sequence == null) return null
  const value = sequenceToNum(sequence)
  return Number.isFinite(value) ? value : null
}

export interface UseComposeTraceResult {
  /** Wire to the composer's focus. Cheap and idempotent within a session. */
  onComposerFocus: () => void
  /** Call at send; spread the result onto the send input. */
  takeComposeTrace: () => Promise<ComposeTrace | undefined>
}

const NO_CAPTURE: UseComposeTraceResult = {
  onComposerFocus: () => {},
  takeComposeTrace: async () => undefined,
}

export interface UseComposeTraceOptions {
  workspaceId: string
  /**
   * The composer's target (stream, thread panel, or board card): when it changes
   * the open session is dropped rather than carried into a different
   * conversation.
   */
  scopeId: string
  /**
   * The stream the horizon is measured against — the surface the author is
   * reading, which is the composer's own host stream, not wherever the send is
   * routed. Undefined (or empty) until it resolves: no session opens, because a
   * horizon with no stream is unreadable rather than merely null.
   */
  horizonStreamId: string | undefined
  /** Read at session open only: "did they resume a draft", not "have they typed since". */
  hasDraftContent: () => boolean
  /**
   * The draft store has hydrated. Autofocus fires during the composer's mount,
   * before a persisted draft is loaded into it, so sampling `hasDraftContent`
   * then reports every resumed draft as fresh. A focus that arrives early is
   * held and opened once this flips.
   */
  draftReady: boolean
}

/**
 * Compose-session capture for one composer. Off unless the workspace's
 * `composeTraces` flag is set to `capture`, in which case the flag-off path does
 * zero IDB reads and attaches nothing to the send.
 *
 * Scheduled sends and slash-command dispatches deliberately never call
 * `takeComposeTrace` — neither is an author deciding to say something now, so a
 * horizon captured for them would be noise.
 */
export function useComposeTrace({
  workspaceId,
  scopeId,
  horizonStreamId,
  hasDraftContent,
  draftReady,
}: UseComposeTraceOptions): UseComposeTraceResult {
  const enabled = useFeatureFlag(workspaceId, "composeTraces") === "capture"
  const recorderRef = useRef<ComposeTraceRecorder | null>(null)
  const hasDraftContentRef = useRef(hasDraftContent)
  hasDraftContentRef.current = hasDraftContent
  const pendingFocusRef = useRef(false)

  const recorder = useMemo(() => {
    if (!enabled) return null
    recorderRef.current ??= new ComposeTraceRecorder()
    recorderRef.current.reset()
    pendingFocusRef.current = false
    return recorderRef.current
    // Re-running on scope OR horizon-stream change is the reset: a composer that
    // switches target — or whose host stream resolves to a different id — must
    // not carry the previous target's horizon into its next send.
  }, [enabled, scopeId, horizonStreamId])

  const onComposerFocus = useCallback(() => {
    if (!recorder || !horizonStreamId) return
    if (!draftReady) {
      pendingFocusRef.current = true
      return
    }
    void recorder.open(scopeId, horizonStreamId, hasDraftContentRef.current())
  }, [recorder, scopeId, horizonStreamId, draftReady])

  useEffect(() => {
    if (!recorder || !horizonStreamId || !draftReady || !pendingFocusRef.current) return
    pendingFocusRef.current = false
    void recorder.open(scopeId, horizonStreamId, hasDraftContentRef.current())
  }, [recorder, scopeId, horizonStreamId, draftReady])

  const takeComposeTrace = useCallback(async () => recorder?.take(), [recorder])

  return enabled ? { onComposerFocus, takeComposeTrace } : NO_CAPTURE
}
